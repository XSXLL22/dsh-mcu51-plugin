"""F449-only validation, before serial construction and before calibration.

No transport imports. The last-sector limit constrains programming, not erase.
"""
import hashlib
import json
import os
from pathlib import Path
import re

LIMIT = 61952


def file_path(value):
    """Use the extended Windows namespace for long I/O paths, not intent IDs."""
    path = Path(value)
    if os.name != 'nt' or not path.is_absolute():
        return path
    text = os.path.abspath(value)
    if len(text) >= 248 and not text.startswith('\\\\?\\'):
        text = '\\\\?\\UNC\\' + text[2:] if text.startswith('\\\\') else '\\\\?\\' + text
    return Path(text)


class MemoryError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def require(ok, message, code='MEMORY_APPLICATION_INVALID'):
    if not ok:
        raise MemoryError(code, message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def sha(value):
    return isinstance(value, str) and re.fullmatch(r'[0-9a-f]{64}', value) is not None


def keys(value, names):
    return isinstance(value, dict) and set(value) == set(names.split())


def file_check(record, limit=16 * 1024 * 1024):
    require(isinstance(record, dict) and isinstance(record.get('path'), str) and Path(record['path']).is_absolute()
            and sha(record.get('sha256')), 'Invalid source path/hash')
    path = file_path(record['path'])
    require(path.is_file() and path.stat().st_size <= limit, 'Source file is missing/too large')
    with path.open('rb') as stream:
        raw = stream.read(limit + 1)
    require(len(raw) <= limit and digest(raw) == record['sha256'], 'Bound source file changed', 'MEMORY_FILE_CHANGED')


def validate_request(spec):
    intent = spec.get('memoryApplication')
    require('optionsApplication' not in spec, 'Memory and option applications cannot be combined')
    require(keys(intent, 'method profileId port requestedFreqHz baseline sourceImage snapshot recoverySource preview image codeRecovery data tailPolicy'),
            'Invalid memory intent shape')
    require(sha(spec.get('applicationId')) and digest(json.dumps(intent, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')) == spec['applicationId'],
            'Memory intent ID differs', 'MEMORY_APPLICATION_ID')
    baseline, image, recovery, data = (intent[name] for name in ('baseline', 'image', 'codeRecovery', 'data'))
    require(intent['method'] == 'reflash-shared-iap' and intent['profileId'] == 'stc15-f449-725s-memory-v1'
            and intent['tailPolicy'] == {'programmingEndExclusive': LIMIT, 'erasePreservation': 'unknown'}, 'Unsupported memory profile')
    require(keys(baseline, 'model magic bslVersion freqHz codeBytes rawMsrHex')
            and baseline['model'] == 'IAP15F2K61S2' and baseline['magic'] == 'F449' and baseline['bslVersion'] == '7.2.5S'
            and type(baseline['codeBytes']) is int and baseline['codeBytes'] == 62464
            and type(baseline['freqHz']) is int and abs(baseline['freqHz'] - 12000000) <= 240000
            and isinstance(baseline['rawMsrHex'], str) and re.fullmatch(r'[0-9a-f]{2}( [0-9a-f]{2}){4}', baseline['rawMsrHex']),
            'Unsupported baseline')
    msr = bytes.fromhex(baseline['rawMsrHex'])
    require(msr[2] & 1 and not msr[3] & 2, 'Requires internal IRC and EEPROM erase disabled')
    require(spec.get('action') == 'flash' and spec.get('protocol') == 'stc15' and spec.get('mcu') == baseline['model']
            and spec.get('clockMode') == 'calibrate' and spec.get('port') == intent['port']
            and isinstance(intent['port'], str) and re.fullmatch(r'COM[1-9][0-9]*', intent['port'])
            and type(intent['requestedFreqHz']) is int and intent['requestedFreqHz'] == 12000000
            and spec.get('freqHz') == intent['requestedFreqHz'], 'Execution parameters differ')
    for record in (image, recovery):
        require(keys(record, 'path sha256 denseBytes denseSha256') and type(record['denseBytes']) is int
                and 0 < record['denseBytes'] <= LIMIT and sha(record['denseSha256']), 'Invalid bound buffer')
        file_check(record)
    require(image['denseBytes'] % 512 == 0 and spec.get('hex') == image['path'] and spec.get('expectedSha256') == image['sha256'],
            'Combined file/size differs')
    require(keys(intent['sourceImage'], 'path sha256 imageId') and sha(intent['sourceImage']['imageId'])
            and keys(intent['snapshot'], 'path sha256') and keys(intent['recoverySource'], 'path sha256'), 'Invalid sources')
    for record in (intent['sourceImage'], intent['snapshot'], intent['recoverySource']):
        file_check(record)
    preview = intent['preview']
    require(keys(preview, 'options memoryPlanId') and sha(preview['memoryPlanId']) and isinstance(preview['options'], dict), 'Invalid preview')
    options = preview['options']
    require(set(options) == {'targetId', 'bslVersion', 'erasePolicy'} | ({'eepromOffset'} if data is not None else set())
            and options['targetId'] == 'stc675:8' and options['bslVersion'] == '7.2.5S' and options['erasePolicy'] == 'code', 'Unsupported placement')
    binding = spec.get('imageBinding')
    require(binding == {'schemaVersion': 1, 'imageId': intent['sourceImage']['imageId'], 'buffer': 'code', 'hexSha256': image['sha256'],
                        'denseSha256': image['denseSha256'], 'denseBytes': image['denseBytes']}, 'Image binding differs')
    end = recovery['denseBytes']
    if data is not None:
        require(keys(data, 'offset bytes sha256') and type(data['offset']) is int and type(data['bytes']) is int
                and data['offset'] >= end and data['offset'] % 512 == 0 and 0 < data['bytes'] <= LIMIT
                and data['offset'] + data['bytes'] <= LIMIT and sha(data['sha256'])
                and type(options.get('eepromOffset')) is int and options['eepromOffset'] == data['offset'], 'Invalid shared-IAP range')
        end = data['offset'] + data['bytes']
    require(image['denseBytes'] == ((end + 511) // 512) * 512, 'Combined padding differs')
    return intent


def validate_bytes(intent, image, recovery):
    code = intent['codeRecovery']
    require(len(image) == intent['image']['denseBytes'] and digest(image) == intent['image']['denseSha256']
            and len(recovery) == code['denseBytes'] and digest(recovery) == code['denseSha256']
            and image[:len(recovery)] == recovery, 'Decoded combined/recovery bytes differ', 'MEMORY_BYTES_CHANGED')
    data = intent['data']
    start = code['denseBytes']
    if data is not None:
        require(image[start:data['offset']] == b'\xff' * (data['offset'] - start)
                and digest(image[data['offset']:data['offset'] + data['bytes']]) == data['sha256'], 'Gap/data bytes differ', 'MEMORY_BYTES_CHANGED')
        start = data['offset'] + data['bytes']
    require(image[start:] == b'\xff' * (len(image) - start), 'Padding bytes differ', 'MEMORY_BYTES_CHANGED')


def validate_baseline(protocol, chip, intent):
    actual = {key: chip[key] for key in ['model', 'magic', 'bslVersion', 'freqHz', 'codeBytes']}
    actual['rawMsrHex'] = chip['hardwareOptions']['rawMsrHex']
    require(actual == intent['baseline'], 'Live status differs; no calibration/erase', 'MEMORY_BASELINE_CHANGED')
    require(not getattr(protocol, 'external_clock', True) and chip['hardwareOptions']['decoder'] == 'stcgal-1.10/Stc15Option',
            'Requires internal-IRC STC15 decoder')
    return bytes.fromhex(actual['rawMsrHex'])
