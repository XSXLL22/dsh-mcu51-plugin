"""Pure parameter/encoding preflight. This module never imports a serial driver."""
import functools
import hashlib
import json
import math
import re
import sys
from pathlib import Path


class ParameterError(Exception):
    def __init__(self, message, code='BAD_SESSION_PARAMETERS'):
        super().__init__(message)
        self.code = code


def require(condition, message, code='BAD_SESSION_PARAMETERS'):
    if not condition:
        raise ParameterError(message, code)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode('utf-8')).hexdigest()


@functools.lru_cache(maxsize=1)
def contract():
    data = json.loads((Path(__file__).resolve().parents[1] / 'data/session-contract.json').read_text(encoding='utf-8'))
    require(data.get('schemaVersion') == 1 and data.get('contractId') == 'mcu51-sessions-v1'
            and data['isp']['baud'] == 115200 and data['isp']['handshakeBaud'] == 2400
            and data['serial']['maxTimeoutMs'] <= 1200000 and data['serial']['maxSendBytes'] <= 65536
            and data['serial']['maxBytesRange'][1] <= 65536, 'Session contract is invalid', 'SESSION_CONTRACT_INVALID')
    return data


def port(value):
    require(isinstance(value, str) and re.fullmatch(r'COM[1-9][0-9]{0,5}', value, re.IGNORECASE), 'port must be COM plus 1~6 digits, without whitespace', 'BAD_PORT')
    return value.upper()


def number(value, limits, name, integer=False):
    require(type(value) in (int, float) and math.isfinite(value) and limits[0] <= value <= limits[1]
            and (not integer or int(value) == value), name + ' must be a number in ' + str(limits) + (' (integer)' if integer else ''))
    return int(value) if int(value) == value else value


def boolean(value, name):
    require(type(value) is bool, name + ' must be boolean')
    return value


def normalize_isp(options):
    require(isinstance(options, dict), 'ISP parameters must be an object')
    limits = contract()['isp']
    spec = dict(options)
    require(spec.get('action') in ('flash', 'chipinfo', 'handshake'), 'Unknown ISP action')
    spec['port'] = port(spec.get('port'))
    spec['waitSeconds'] = number(spec.get('waitSeconds', limits['waitSeconds']), limits['waitRange'], 'waitSeconds', True)
    spec['debug'] = boolean(spec.get('debug', False), 'debug')
    require(spec.get('clockMode', 'calibrate') in ('calibrate', 'preserve'), 'clockMode must be calibrate/preserve')
    spec['clockMode'] = spec.get('clockMode', 'calibrate')
    for name in ('baud', 'handshakeBaud'):
        value = spec.get(name, limits[name])
        require(type(value) is int and value == limits[name], 'ISP ' + name + ' is fixed at ' + str(limits[name]))
        spec[name] = value
    if spec.get('freqHz') is not None:
        spec['freqHz'] = number(spec['freqHz'], limits['frequencyRange'], 'freqHz', True)
    model = spec.get('mcu')
    if model is not None:
        require(isinstance(model, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]{0,63}', model), 'mcu must be a model string')
        spec['mcu'] = model.upper()
    require(spec['action'] != 'flash' or bool(model), 'Flash requires mcu', 'MCU_REQUIRED')
    require(spec.get('protocol', 'auto') in ('auto', 'stc89', 'stc89a', 'stc15', 'stc15a'), 'Unknown ISP protocol')
    spec['protocol'] = spec.get('protocol', 'auto')
    require(spec['action'] != 'flash' or spec['protocol'] != 'auto', 'Flash requires an explicit protocol')
    if 'expectedUid' in spec:
        uid = spec['expectedUid']
        require(isinstance(uid, str) and re.fullmatch(r'[0-9a-fA-F]{14}', uid) is not None,
                'expectedUid must contain exactly14 hex digits')
        require(spec['action'] == 'flash' and spec.get('mcu') == 'IAP15F2K61S2'
                and spec['protocol'] == 'stc15' and spec['clockMode'] == 'calibrate',
                'expectedUid requires IAP15F2K61S2/stc15/calibrate flash')
        spec['expectedUid'] = uid.upper()
    spec['timeoutMs'] = spec['waitSeconds'] * 1000 + limits['overheadMs']
    return spec


def hex_bytes(value):
    require(isinstance(value, str), 'HEX payload must be a string')
    compact = re.sub(r'[ \t\r\n\v\f]', '', value)
    require(bool(compact) and re.fullmatch(r'(?:[0-9a-fA-F]{2})+', compact), 'HEX payload must contain complete hex bytes')
    return bytes.fromhex(compact)


def text(value, name, maximum=None):
    require(isinstance(value, str), name + ' must be a string')
    value.encode('utf-8', errors='strict')
    if maximum is not None:
        require(len(value) <= maximum, name + ' is too long')
    return value


def normalize_serial(options, prepared=False):
    require(isinstance(options, dict), 'Serial parameters must be an object')
    rules = contract()['serial']
    defaults = rules['defaults']
    extra = {'port', 'send', 'until', 'untilRegex'} | (set() if prepared else {'sendHex'})
    require(not (set(options) - set(defaults) - extra), 'Unknown serial parameters: ' + str(sorted(set(options) - set(defaults) - extra)))
    spec = {**defaults, **options}
    spec['port'] = port(options.get('port'))
    for name in ('autoBaud', 'noReset', 'rtscts', 'dsrdtr', 'xonxoff'):
        spec[name] = boolean(spec[name], name)
    for name, key, integral in [('seconds', 'secondsRange', False), ('trialSeconds', 'trialSecondsRange', False),
                               ('openDelayMs', 'openDelayMsRange', True), ('openRetrySeconds', 'openRetrySecondsRange', False),
                               ('writeTimeoutSeconds', 'writeTimeoutSecondsRange', False), ('maxLines', 'maxLinesRange', True),
                               ('maxBytes', 'maxBytesRange', True)]:
        spec[name] = number(spec[name], rules[key], name, integral)
    require(type(spec['dataBits']) is int and spec['dataBits'] in rules['dataBits'], 'dataBits must be 5/6/7/8')
    require(type(spec['stopBits']) in (int, float) and spec['stopBits'] in rules['stopBits'], 'stopBits must be 1/1.5/2')
    spec['stopBits'] = number(spec['stopBits'], [1, 2], 'stopBits')
    require(spec['parity'] in rules['parities'], 'parity must be N/E/O/M/S')
    require(not (spec['dataBits'] == 5 and spec['stopBits'] == 2) and not (spec['dataBits'] != 5 and spec['stopBits'] == 1.5), 'Outside current 8250-compatible dataBits/stopBits profile')
    require(not (spec['rtscts'] and spec['xonxoff']), 'Select hardware or software flow control, not both')
    require(not (spec['noReset'] and (spec['rtscts'] or spec['dsrdtr'])), 'Hardware flow control requires noReset=false')
    require(spec['dataMode'] in ('text', 'binary'), 'dataMode must be text/binary')
    require(spec['encoding'] in rules['encodings'], 'Unsupported encoding')
    require(spec['newline'] in rules['newlines'], 'Unsupported newline')
    if spec['autoBaud']:
        require(spec['dataMode'] == 'text', 'Binary mode requires explicit baud')
        require(prepared or 'baud' not in options, 'autoBaud cannot be combined with explicit baud')
        candidates = options['baudCandidates'] if 'baudCandidates' in options else rules['defaultBaudCandidates']
        require(isinstance(candidates, list) and 1 <= len(candidates) <= rules['maxBaudCandidates'], 'Invalid baudCandidates')
        spec['baudCandidates'] = [number(item, rules['baudRange'], 'baudCandidates', True) for item in candidates]
        require(len(set(spec['baudCandidates'])) == len(spec['baudCandidates']), 'Duplicate baudCandidates')
        spec['baud'] = 0
    else:
        spec['baud'] = number(spec['baud'], rules['baudRange'], 'baud', True)
        require(spec['baudCandidates'] == [], 'baudCandidates requires autoBaud=true')
    until = options.get('until', [])
    until = [until] if isinstance(until, str) else until
    require(isinstance(until, list) and len(until) <= rules['maxUntilItems'], 'until must be a string or bounded list')
    spec['until'] = [text(item, 'until', rules['maxUntilLength']) for item in until]
    require(all(spec['until']), 'until entries must not be empty')
    regex = options.get('untilRegex')
    if regex is not None:
        text(regex, 'untilRegex', rules['maxUntilLength'])
        re.compile(regex)
    spec['untilRegex'] = regex
    require(spec['dataMode'] != 'binary' or (not until and regex is None), 'Binary mode does not accept text until conditions')
    items = options.get('send', [])
    if isinstance(items, str):
        items = [item.strip() for item in items.split(';') if item.strip()]
    require(isinstance(items, list), 'send must be a list or semicolon string')
    if not prepared:
        hexadecimal = options.get('sendHex', [])
        require(isinstance(hexadecimal, list), 'sendHex must be an array')
        items = [*items, *[{'hex': item} for item in hexadecimal]]
    require(len(items) <= rules['maxSendItems'], 'Too many send items')
    outgoing = []
    total = 0
    for item in items:
        item = {'text': item} if isinstance(item, str) else item
        require(isinstance(item, dict), 'Each send item must be text or an object')
        if prepared:
            require(set(item) == {'hex', 'displayText', 'delayMs', 'newline'} and item['newline'] is False, 'Invalid frozen send item')
            payload = hex_bytes(item['hex'])
            display = text(item['displayText'], 'displayText')
        else:
            require(not (set(item) - {'hex', 'text', 'delayMs', 'newline'}) and (('hex' in item) != ('text' in item)), 'Send item needs exactly one of text/hex')
            newline = boolean(item.get('newline', True), 'send.newline')
            display = text(item.get('text', ''), 'send.text')
            payload = hex_bytes(item['hex']) if 'hex' in item else (display + (rules['newlines'][spec['newline']] if newline else '')).encode(spec['encoding'], errors='strict')
        total += len(payload)
        require(bool(payload) and total <= rules['maxSendBytes'], 'Empty payload or total send size exceeds limit')
        require(all(byte < (1 << spec['dataBits']) for byte in payload), 'Payload byte does not fit configured dataBits')
        outgoing.append({'hex': payload.hex(), 'displayText': display, 'delayMs': number(item.get('delayMs', 0), rules['sendDelayMsRange'], 'send.delayMs', True), 'newline': False})
    spec.pop('sendHex', None)
    spec['send'] = outgoing
    return spec


def serial_budget(spec):
    rules = contract()['serial']
    probe_count = len(spec['baudCandidates']) if spec['autoBaud'] else 0
    send_bytes = sum(len(item['hex']) // 2 for item in spec['send'])
    baud = min(spec['baudCandidates']) if probe_count else spec['baud']
    frame_bits = 1 + spec['dataBits'] + (spec['parity'] != 'N') + spec['stopBits']
    result = {'captureMs': math.ceil(spec['seconds'] * 1000), 'probeMs': math.ceil(spec['trialSeconds'] * 1000) * probe_count,
              'openRetryMs': math.ceil(spec['openRetrySeconds'] * 1000) * (probe_count + 1), 'openDelayMs': spec['openDelayMs'],
              'sendDelaysMs': sum(item['delayMs'] for item in spec['send']), 'writeMs': math.ceil(spec['writeTimeoutSeconds'] * 1000) * len(spec['send']),
              'wireMs': math.ceil(send_bytes * frame_bits / baud * 1000), 'overheadMs': rules['overheadMs'], 'sendBytes': send_bytes}
    result['timeoutMs'] = sum(value for name, value in result.items() if name.endswith('Ms'))
    require(result['timeoutMs'] <= rules['maxTimeoutMs'], 'Serial session exceeds maximum time budget')
    return result


def make_serial_plan(options):
    spec = normalize_serial(options)
    core = {'schemaVersion': 1, 'kind': 'mcu51-serial-session', 'contractSha256': digest(contract()), 'spec': spec, 'budget': serial_budget(spec)}
    return {**core, 'sessionPlanId': digest(core)}


def verify_serial_plan(plan, expected_id):
    require(isinstance(plan, dict) and set(plan) == {'schemaVersion', 'kind', 'contractSha256', 'spec', 'budget', 'sessionPlanId'}, 'Invalid session plan')
    require(isinstance(expected_id, str) and re.fullmatch(r'[0-9a-f]{64}', expected_id) and expected_id == plan['sessionPlanId'], 'Session ID mismatch', 'SESSION_PLAN_CHANGED')
    core = {name: value for name, value in plan.items() if name != 'sessionPlanId'}
    require(type(plan['schemaVersion']) is int and plan['schemaVersion'] == 1 and plan['kind'] == 'mcu51-serial-session' and plan['contractSha256'] == digest(contract())
            and digest(core) == expected_id, 'Session plan changed', 'SESSION_PLAN_CHANGED')
    spec = normalize_serial(plan['spec'], prepared=True)
    require(isinstance(plan['budget'], dict) and all(type(value) is int for value in plan['budget'].values()), 'Budget must contain integer values')
    require(spec == plan['spec'] and serial_budget(spec) == plan['budget'], 'Session bytes/parameters/budget are inconsistent', 'SESSION_PLAN_CHANGED')
    return spec


def failure(error):
    return {'ok': False, 'error': getattr(error, 'code', 'BAD_SESSION_PARAMETERS'), 'message': str(error), 'hardwareAccess': False, 'stage': 'preflight'}


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    try:
        raw = sys.stdin.buffer.read(2 * 1024 * 1024 + 1)
        require(len(raw) <= 2 * 1024 * 1024, 'Session request is too large')
        request = json.loads(raw.decode('utf-8'))
        require(isinstance(request, dict) and request.get('kind') == 'serial', 'Expected serial planning request')
        result = {'ok': True, 'plan': make_serial_plan(request.get('options')), 'hardwareAccess': False}
    except Exception as error:
        result = failure(error)
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
