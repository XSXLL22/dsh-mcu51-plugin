#!/usr/bin/env python3
"""串口抓包 sidecar：一次开端口、按行打时间戳、可连发多条指令、可自动试波特率。

协议：stdin 一个 JSON 对象 → stdout NDJSON；阶段/发送进度之后，最后一行为result。
字段见 DEFAULT_SPEC。
"""
import importlib.util
import functools
import json
from pathlib import Path
import re
import sys
import time

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

DEFAULT_SPEC = {
    "port": "COM9",
    "baud": 9600,
    "seconds": 5.0,
    "openDelayMs": 0,
    "send": [],
    "newline": "crlf",
    "until": [],
    "untilRegex": None,
    "maxLines": 400,
    "baudCandidates": [],
    "trialSeconds": 2,
    "noReset": True,
    "encoding": "ascii",
    "openRetrySeconds": 0,
    "dataMode": "text",
    "maxBytes": 65536,
}


def now():
    return time.time()


def decode_line(raw, encoding):
    try:
        return raw.decode(encoding, errors="replace")
    except Exception:
        return raw.decode("latin1", errors="replace")


class LineBuffer:
    """CR completes immediately; consume its optional LF even across reads.

    Pop one line at a time so a stop condition retains all unreported bytes.
    Raw capture is separate and never changed by this text framing state.
    """
    def __init__(self):
        self.rest = b''
        self.after_cr = False

    def append(self, chunk):
        if self.after_cr and chunk:
            if chunk.startswith(b'\n'):
                chunk = chunk[1:]
            self.after_cr = False
        self.rest += chunk

    def pop_line(self):
        match = re.search(b'[\r\n]', self.rest)
        if match is None:
            return None
        index = match.start()
        line, sep = self.rest[:index], self.rest[index:index + 1]
        self.rest = self.rest[index + 1:]
        if sep == b'\r':
            if self.rest.startswith(b'\n'):
                self.rest = self.rest[1:]
            elif not self.rest:
                self.after_cr = True
        return line


def printable_ratio(data):
    if not data:
        return 0.0
    good = sum(1 for b in data if 32 <= b < 127 or b in (9, 10, 13))
    return good / len(data)


def encode_payload(item, suffix, encoding):
    if "hex" in item:
        return bytes.fromhex(item["hex"])
    return (item.get("text", "") + (suffix if item.get("newline", True) else "")).encode(encoding, errors="strict")


def open_port(spec, baud):
    import serial
    kwargs = {'port': None, 'baudrate': baud, 'timeout': 0.05, 'write_timeout': spec.get('writeTimeoutSeconds', 2),
              'bytesize': spec.get('dataBits', 8), 'parity': spec.get('parity', 'N'), 'stopbits': spec.get('stopBits', 1),
              'dsrdtr': spec.get('dsrdtr', False), 'rtscts': spec.get('rtscts', False), 'xonxoff': spec.get('xonxoff', False)}
    deadline = time.monotonic() + spec.get('openRetrySeconds', 0)
    while True:
        handle = None
        try:
            handle = serial.Serial(**kwargs)
            if spec.get('noReset', True):
                handle.dtr = False
                handle.rts = False
            handle.port = spec['port']
            handle.open()
            return handle, None
        except Exception as error:
            if handle is not None:
                try:
                    handle.close()
                except Exception as close_error:
                    return None, RuntimeError(str(error) + '; close: ' + str(close_error))
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None, error
            time.sleep(min(0.25, remaining))


def collect(ser, spec, until_hit=False):
    started = time.monotonic()
    framing = LineBuffer()
    raw_all = bytearray()
    lines = []
    total = 0
    matched = None
    until = [item.lower() for item in spec.get('until', [])]
    until_re = re.compile(spec['untilRegex']) if spec.get('untilRegex') is not None else None
    max_lines = spec.get('maxLines', 400)
    max_bytes = spec.get('maxBytes', 65536)
    deadline = started + spec.get('seconds', 5)
    reason = 'duration'
    error = None
    while time.monotonic() < deadline:
        if until_hit:
            reason = 'until'
            break
        if total >= max_bytes:
            reason = 'maxBytes'
            break
        try:
            chunk = ser.read(min(512, max_bytes - total))
        except Exception as read_error:
            error = 'READ_ERROR: ' + str(read_error)
            reason = 'read-error'
            break
        if not chunk:
            continue
        total += len(chunk)
        raw_all.extend(chunk)
        if spec.get('dataMode', 'text') == 'binary':
            continue
        framing.append(chunk)
        while True:
            raw = framing.pop_line()
            if raw is None:
                break
            value = decode_line(raw, spec.get('encoding', 'ascii')).strip()
            lines.append({'t': round(time.monotonic() - started, 3), 'text': value})
            if until and any(item in value.lower() for item in until):
                matched = value
            if until_re and until_re.search(value):
                matched = value
            if matched is not None or len(lines) >= max_lines:
                reason = 'until' if matched is not None else 'maxLines'
                break
        if matched is not None or len(lines) >= max_lines:
            break
    return {'lines': lines, 'total': total, 'raw': bytes(raw_all), 'tail': framing.rest, 'matched': matched, 'error': error,
            'stopReason': reason, 'elapsedSeconds': round(time.monotonic() - started, 3)}


def close_port(ser, errors):
    try:
        ser.close()
    except Exception as error:
        errors.append('serial close: ' + str(error))


def run_capture(spec, emit=lambda event: None):
    trials = []
    cleanup_errors = []
    baud = int(spec.get('baud') or 0)
    port = spec['port']
    emit({'event': 'stage', 'stage': 'serial-opening'})
    if not baud or spec.get('baudCandidates'):
        candidates = spec.get('baudCandidates') or [9600, 2400, 115200, 4800]
        scored = []
        for candidate in candidates:
            ser, error = open_port(spec, candidate)
            if ser is None:
                trials.append({'baud': candidate, 'ok': False, 'error': str(error)})
                continue
            try:
                probe_spec = dict(spec, seconds=float(spec.get('trialSeconds') or 2.0), maxLines=50, until=[], untilRegex=None)
                got = collect(ser, probe_spec)
            finally:
                close_port(ser, cleanup_errors)
            if cleanup_errors:
                return {'ok': False, 'error': 'PORT_CLOSE_FAILED', 'cleanupErrors': cleanup_errors, 'trials': trials, 'port': port}
            ratio = printable_ratio(got['raw'])
            text_lines = [line for line in got['lines'] if line['text']]
            score = ratio * 3 + min(len(text_lines), 2)
            trials.append({'baud': candidate, 'ok': got['error'] is None, 'lines': len(text_lines), 'bytes': got['total'],
                           'printableRatio': round(ratio, 3), 'score': round(score, 3), 'readError': got['error']})
            if got['error'] is None:
                scored.append({'baud': candidate, 'score': score, 'ratio': ratio, 'bytes': got['total']})
        if not scored:
            return {'ok': False, 'error': 'PORT_OPEN_FAILED', 'port': port, 'trials': trials, 'message': 'No usable serial probe'}
        accepted = [item for item in scored if item['ratio'] >= 0.75 and item['bytes'] > 0]
        with_bytes = [item for item in scored if item['bytes'] > 0]
        baud = (max(accepted, key=lambda item: item['score']) if accepted else
                max(with_bytes, key=lambda item: item['ratio']) if with_bytes else scored[0])['baud']
    ser, error = open_port(spec, baud)
    if ser is None:
        return {'ok': False, 'error': 'PORT_OPEN_FAILED', 'port': port, 'baud': baud, 'trials': trials, 'message': str(error)}
    sent = []
    send_error = None
    send_attempted = False
    unexpected_error = None
    got = None
    try:
        open_delay = float(spec.get('openDelayMs') or 0) / 1000.0
        if open_delay > 0:
            time.sleep(open_delay)
        suffix = {'crlf': '\r\n', 'lf': '\n', 'cr': '\r', 'none': ''}.get(spec.get('newline') or 'crlf', '\r\n')
        if spec.get('send'):
            emit({'event': 'stage', 'stage': 'sending'})
        for item in spec.get('send') or []:
            delay = float(item.get('delayMs', 0)) / 1000.0
            if delay > 0:
                time.sleep(delay)
            try:
                payload = encode_payload(item, suffix, spec.get('encoding') or 'ascii')
                send_attempted = True
                written = ser.write(payload)
                if written != len(payload):
                    raise RuntimeError('Partial write: ' + str(written) + '/' + str(len(payload)) + ' bytes')
                ser.flush()
                receipt = {'text': item.get('displayText', item.get('text', '')), 'hex': payload.hex(' '), 'at': round(now(), 3)}
                sent.append(receipt)
                emit({'event': 'serial-sent', 'sent': receipt})
            except Exception as error:
                send_error = str(error)
                break
        emit({'event': 'stage', 'stage': 'collecting'})
        got = collect(ser, spec)
    except Exception as error:
        unexpected_error = str(error)
    finally:
        close_port(ser, cleanup_errors)
    if unexpected_error:
        return {'ok': False, 'error': 'SERIAL_CAPTURE_FAILED', 'message': unexpected_error, 'port': port, 'baud': baud,
                'sent': sent, 'bytes': None, 'captureIncomplete': True, 'cleanupErrors': cleanup_errors,
                'sendMayHaveStarted': send_attempted, 'transmitState': 'unknown-after-capture-error' if send_attempted else 'not-started'}
    tail = got['tail']
    return {'ok': got['error'] is None and send_error is None and not cleanup_errors, 'port': port, 'baud': baud,
            'seconds': spec.get('seconds', 5), 'elapsedSeconds': got.get('elapsedSeconds'), 'stopReason': got.get('stopReason'), 'lines': got['lines'], 'lineCount': len(got['lines']),
            'bytes': got['total'], 'printableRatio': round(printable_ratio(got['raw']), 3), 'matched': got['matched'],
            'trials': trials, 'sent': sent, 'sendError': send_error, 'readError': got['error'], 'cleanupErrors': cleanup_errors,
            'sendMayHaveStarted': send_attempted,
            'transmitState': 'partial-or-failed' if send_error else 'host-writes-complete' if send_attempted else 'not-requested',
            'residual': decode_line(tail, spec.get('encoding') or 'ascii') if tail else '',
            'rawHex': got['raw'].hex(' '), 'rawTruncated': got['total'] > len(got['raw']),
            **({'error': 'PORT_CLOSE_FAILED', 'message': '; '.join(cleanup_errors)} if cleanup_errors else {})}


def port_sessions():
    spec = importlib.util.spec_from_file_location('dsh_port_session', Path(__file__).with_name('port_session.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@functools.lru_cache(maxsize=1)
def session_parameters():
    spec = importlib.util.spec_from_file_location('dsh_session_parameters', Path(__file__).with_name('session_parameters.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_locked_capture(request, emit=lambda event: None, worker=run_capture, lease_factory=None):
    try:
        parameters = session_parameters()
        parameters.require(isinstance(request, dict), 'Serial request must be an object')
        dry_run = parameters.boolean(request.get('dryRun', False), 'dryRun')
        if 'sessionPlan' in request:
            parameters.require(not (set(request) - {'sessionPlan', 'expectedSessionPlanId', 'dryRun'}), 'Frozen plan cannot be mixed with raw parameters')
            plan = request['sessionPlan']
            spec = parameters.verify_serial_plan(plan, request.get('expectedSessionPlanId'))
        else:
            raw = {key: value for key, value in request.items() if key != 'dryRun'}
            plan = parameters.make_serial_plan(raw)
            spec = plan['spec']
        if dry_run:
            return {'event': 'result', 'ok': True, 'dryRun': True, 'hardwareAccess': False, 'sessionPlan': plan,
                    'sessionPlanId': plan['sessionPlanId'], 'bytes': 0, 'sent': []}
    except Exception as error:
        return {'event': 'result', 'ok': False, 'error': getattr(error, 'code', 'BAD_SESSION_PARAMETERS'), 'message': str(error),
                'hardwareAccess': False, 'stage': 'preflight'}
    result = port_sessions().run_exclusive(spec['port'], 'serial', lambda: worker(spec, emit=emit),
                                          lease_factory=lease_factory,
                                          on_acquired=lambda info: emit({'event': 'session-acquired', 'session': info}))
    result['event'] = 'result'
    result.setdefault('sessionPlanId', plan['sessionPlanId'])
    result['requestedFrame'] = {name: spec[name] for name in ('dataBits', 'parity', 'stopBits', 'rtscts', 'dsrdtr', 'xonxoff', 'noReset')}
    return result


def main():
    try:
        raw = json.loads(sys.stdin.buffer.read().decode('utf-8'))
        if not isinstance(raw, dict):
            raise ValueError('Serial request must be an object')
        result = run_locked_capture(raw, emit=lambda event: print(json.dumps(event, ensure_ascii=False), flush=True))
    except Exception as error:
        result = {'event': 'result', 'ok': False, 'error': 'BAD_SPEC', 'message': str(error)}
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
