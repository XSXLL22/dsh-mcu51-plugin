"""Bundled opt-in F449 erase receiver, adapted from MCU-034/035 evidence.

No development directory, executable, fixed port or board UID is needed.
UID is checked only after the erase request, never a pre-erase attestation.
"""
import contextlib
import ctypes
import re
import sys
import time

WINDOW_SECONDS = 10.0
MAX_BYTES = 4096
MAX_POLLS = 4096
POLL_SECONDS = 0.005


class ReceiveError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class FrameSearch:
    """Incremental 00-high-length/16-bit-checksum parser, max249 payload bytes."""
    def __init__(self):
        self.state = 0
        self.body = bytearray()
        self.remaining = 0
        self.invalid_frames = 0
        self.invalid_lengths = 0

    def start(self, byte):
        self.state = 1 if byte == 0x46 else 3 if byte == 0x68 else 0

    @property
    def wanted(self):
        return self.remaining - len(self.body) if self.state == 5 else 1

    def feed(self, data):
        frames = []
        for byte in data:
            if self.state == 0:
                self.start(byte)
            elif self.state == 1:
                if byte == 0xb9: self.state = 2
                else: self.start(byte)
            elif self.state == 2:
                if byte == 0x68: self.state = 3
                else: self.start(byte)
            elif self.state == 3:
                if byte == 0: self.state = 4
                else: self.start(byte)
            elif self.state == 4:
                if byte < 6:
                    # Unlike the EXE model, explicitly defend malformed lengths.
                    self.invalid_lengths += 1
                    self.start(byte)
                else:
                    self.remaining = byte - 3
                    self.body = bytearray()
                    self.state = 5
            else:
                self.body.append(byte)
                if len(self.body) == self.remaining:
                    payload = bytes(self.body[:-3])
                    valid = (self.body[-1] == 0x16 and
                             int.from_bytes(self.body[-3:-1], 'big') ==
                             (sum(payload) + len(payload) + 0x6e) & 0xffff)
                    self.state = 0
                    if valid: frames.append(payload)
                    else: self.invalid_frames += 1
        return frames


def error_info(error):
    return {'type': type(error).__name__, 'message': str(error),
            **{key: getattr(error, key) for key in ('code', 'winerror', 'errno') if getattr(error, key, None) is not None}}


@contextlib.contextmanager
def native_nonblocking(handle, evidence):
    """Read immediately without setting pyserial properties/DCB or purging RX."""
    if sys.platform != 'win32':
        raise ReceiveError('ERASE_RX_PLATFORM', 'Explicit receiver requires Windows transport')
    from serial import win32
    old = win32.COMMTIMEOUTS()
    state = evidence['nativeTimeouts']
    if not win32.GetCommTimeouts(handle._port_handle, ctypes.byref(old)):
        raise ctypes.WinError(win32.GetLastError())
    state['snapshotTaken'] = True
    state['before'] = {name: int(getattr(old, name)) for name, *_ in old._fields_}
    current = win32.COMMTIMEOUTS()
    ctypes.memmove(ctypes.byref(current), ctypes.byref(old), ctypes.sizeof(old))
    current.ReadIntervalTimeout = win32.MAXDWORD
    current.ReadTotalTimeoutMultiplier = current.ReadTotalTimeoutConstant = 0
    primary_failed = False
    try:
        state['setAttempted'] = True
        if not win32.SetCommTimeouts(handle._port_handle, ctypes.byref(current)):
            raise ctypes.WinError(win32.GetLastError())
        state['nonblockingSet'] = True
        yield
    except BaseException:
        primary_failed = True
        raise
    finally:
        if not win32.SetCommTimeouts(handle._port_handle, ctypes.byref(old)):
            error = ctypes.WinError(win32.GetLastError())
            evidence['cleanupErrors'].append({'phase': 'restore-timeouts', **error_info(error)})
            if not primary_failed:
                raise ReceiveError('ERASE_RX_TIMEOUT_RESTORE', 'ACK cannot be used: restoring native timeouts failed') from error
        else:
            state['restored'] = True


def read_erase_reply(protocol, expected_uid, evidence, *, clock, sleep, timeout_mode):
    parser = FrameSearch()
    start = clock()
    deadline = start + WINDOW_SECONDS
    evidence['readInvoked'] = True
    evidence['stopReason'] = 'reading'
    answer = None

    def stop(code, reason):
        evidence['stopReason'] = reason
        raise ReceiveError(code, 'F449 erase reply rejected: ' + reason)

    try:
        with timeout_mode(protocol.ser, evidence):
            while answer is None:
                if clock() >= deadline: stop('ERASE_RX_TIMEOUT', 'duration')
                if evidence['readBytes'] >= MAX_BYTES: stop('ERASE_RX_BYTE_BUDGET', 'maxBytes')
                if evidence['polls'] >= MAX_POLLS: stop('ERASE_RX_POLL_BUDGET', 'maxPolls')
                evidence['polls'] += 1
                count = min(parser.wanted, MAX_BYTES - evidence['readBytes'])
                data = protocol.ser.read(count)
                if len(data) > count:
                    stop('ERASE_RX_TRANSPORT', 'transport-returned-more-than-requested')
                evidence['rxHex'] += data.hex()
                evidence['readBytes'] += len(data)
                # A driver returning after the deadline must not produce success.
                if clock() >= deadline: stop('ERASE_RX_TIMEOUT', 'duration')
                for payload in parser.feed(data):
                    # Semantic errors terminate; do not search past a wrong UID/opcode.
                    if len(payload) != 8 or payload[0] != 3:
                        stop('ERASE_RX_ACK_INVALID', 'expected-exact03-and-seven-byte-UID')
                    evidence['actualUid'] = payload[1:].hex().upper()
                    if payload[1:] != expected_uid:
                        stop('ERASE_RX_UID_MISMATCH', 'UID-mismatch')
                    answer = payload
                    evidence['frameAndUidMatched'] = True
                if not data:
                    evidence['emptyPolls'] += 1
                    sleep(min(POLL_SECONDS, max(0, deadline - clock())))
        evidence['stopReason'] = 'checked-ACK-and-timeouts-restored'
        return answer
    except Exception as error:
        if evidence['stopReason'] == 'reading': evidence['stopReason'] = 'transport-or-timeout-mode-error'
        evidence['failure'] = error_info(error)
        raise
    finally:
        evidence['invalidFrames'] = parser.invalid_frames
        evidence['invalidLengths'] = parser.invalid_lengths
        evidence['partialState'] = parser.state
        evidence['elapsedMs'] = round((clock() - start) * 1000, 3)


def prepare(protocol, expected_uid, *, clock=None, sleep=None, timeout_mode=None):
    """Validate before handshake; return per-session receipt and one erase call."""
    if not isinstance(expected_uid, str) or re.fullmatch(r'[0-9a-fA-F]{14}', expected_uid) is None:
        raise ReceiveError('BAD_SESSION_PARAMETERS', 'Explicit known seven-byte UID required')
    uid = bytes.fromhex(expected_uid)
    if (protocol.mcu_magic != 0xf449 or protocol.mcu_bsl_version != '7.2.5S'
            or protocol.external_clock or sys.platform != 'win32'):
        raise ReceiveError('ERASE_RX_PROFILE', 'Bound receiver requires Windows/internal-IRC F449/7.2.5S')
    if protocol.uid and bytes(protocol.uid) != uid:
        raise ReceiveError('ERASE_RX_UID_MISMATCH', 'Existing session UID differs before erase')
    evidence = {'kind': 'bounded-F449-erase-receiver', 'schemaVersion': 1,
                'profile': 'F449/7.2.5S/internal-IRC/erase-only', 'expectedUid': uid.hex().upper(), 'actualUid': None,
                'identityCheckPhase': 'erase-response', 'beforeEraseIdentityVerified': False,
                'invoked': False, 'readInvoked': False, 'originalEraseReturned': False,
                'frameAndUidMatched': False, 'failure': None, 'cleanupErrors': [],
                'limits': {'windowMs': 10000, 'bytes': MAX_BYTES, 'polls': MAX_POLLS},
                'rxHex': '', 'readBytes': 0, 'polls': 0, 'emptyPolls': 0, 'stopReason': 'not-invoked',
                'invalidFrames': 0, 'invalidLengths': 0,
                'nativeTimeouts': {'snapshotTaken': False, 'setAttempted': False, 'nonblockingSet': False, 'restored': False}}
    original = protocol.erase_flash
    def erase(erase_size, flash_size):
        if evidence['invoked']:
            raise ReceiveError('ERASE_RX_RETRY', 'One erase per prepared session; no retry')
        evidence['invoked'] = True
        prior = protocol.__dict__.get('read_packet')
        overridden = 'read_packet' in protocol.__dict__
        calls = 0
        def read():
            nonlocal calls
            calls += 1
            if calls != 1: raise ReceiveError('ERASE_RX_RETRY', 'Unexpected second erase response read')
            return read_erase_reply(protocol, uid, evidence, clock=clock or time.monotonic,
                                   sleep=sleep or time.sleep, timeout_mode=timeout_mode or native_nonblocking)
        protocol.read_packet = read
        try:
            original(erase_size, flash_size)
            evidence['originalEraseReturned'] = True
        except Exception as error:
            evidence['failure'] = error_info(error)
            raise
        finally:
            if overridden: protocol.read_packet = prior
            else: del protocol.read_packet
    return evidence, erase
