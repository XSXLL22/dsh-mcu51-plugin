"""STC UART ISP using bundled stcgal. stdout: NDJSON; stderr: diagnostics.

chipinfo never calls handshake/calibration, erase, program or program_options.
"""
import contextlib
import functools
import hashlib
import io
import importlib.util
import json
import math
import re
import struct
import sys
import time
from pathlib import Path
from types import SimpleNamespace


class IspError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def emit_event(event):
    print(json.dumps(event, ensure_ascii=False), flush=True)


@functools.lru_cache(maxsize=1)
def official_option_data():
    path = Path(__file__).resolve().parents[1] / 'data/official-stc15.json'
    data = json.loads(path.read_text(encoding='utf-8'))
    if data.get('schemaVersion') != 1 or not isinstance(data.get('models'), list):
        raise ValueError('Invalid official option metadata schema')
    return data


def enrich_official_options(protocol, result):
    if result['decoder'] != 'stcgal-1.10/Stc15Option' or result['rawMsrHex'] is None or len(result['rawMsrHex'].split()) != 5:
        return
    name = getattr(getattr(protocol, 'model', None), 'name', None)
    magic = getattr(protocol, 'mcu_magic', None)
    if name is None or magic is None:
        return
    data = official_option_data()
    profile = next((entry for entry in data['models'] if entry['model'] == name and int(entry['magic'], 16) == magic), None)
    if profile is None:
        return
    provenance = {'mapping': 'official-static', 'validation': 'offline', 'hardwareValidated': False,
                  'sourceId': data['source']['id'], 'exeSha256': data['source']['exeSha256']}
    encoding = result['values'].get('low_voltage_threshold')
    if type(encoding) is int and 0 <= encoding < 8:
        voltages = profile['lowVoltage']['nominalVoltsByEncoding']
        if len(voltages) != 8 or any(type(value) not in (int, float) or not math.isfinite(value) for value in voltages):
            raise ValueError('Invalid official nominal voltage table')
        result['fieldMetadata']['low_voltage_threshold'] = {
            **provenance, 'unit': 'encoding', 'volts': voltages[encoding],
            'voltageKind': 'nominal-official-display', 'nominalVoltsByEncoding': voltages,
            'modelRecordVA': profile['recordVA'], 'tableEndVA': profile['lowVoltage']['tableEndVA']}
    for field, description in [('uart2_passthrough', 'TXD直通输出RXD电平；false为独立IO'),
                               ('uart2_pin_mode', 'TXD复位后模式；normal为弱上拉双向口，push-pull为强推挽')]:
        if field in result['values']:
            result['fieldMetadata'][field] = {**provenance, 'legacyName': True, 'physicalSignal': 'TXD', 'description': description}


def hardware_options(protocol):
    """Read a typed snapshot of the options decoded from initial BSL status.

    Never calls a setter or a serial method. Do not use stcgal1.10 get_option:
    it passes the option name to getters that take no positional arguments.
    Keep unverified voltage/pin interpretations distinct from raw field values.
    """
    decoder = getattr(protocol, 'options', None)
    result = {'schemaVersion': 1, 'available': decoder is not None, 'support': 'unknown',
              'ok': True, 'readOnly': True, 'source': 'initial-bootloader-status',
              'decoder': None, 'rawMsrHex': None, 'values': {}, 'unknownFields': [],
              'fieldMetadata': {}, 'errors': []}
    if decoder is None:
        result['reason'] = 'No hardware-option decoder is available for this session'
        return result
    result['support'] = 'supported'
    result['decoder'] = 'stcgal-1.10/' + type(decoder).__name__
    try:
        raw = decoder.get_msr()
        if type(raw) is int:
            if not 0 <= raw <= 255:
                raise ValueError('Integer option register must be an unsigned byte')
            raw = bytes([raw])
        elif isinstance(raw, (bytes, bytearray, memoryview)):
            raw = bytes(raw)
        else:
            raise TypeError('Unsupported raw option register representation')
        result['rawMsrHex'] = raw.hex(' ')
    except Exception as exc:
        result['errors'].append({'field': 'rawMsrHex', 'error': type(exc).__name__, 'message': str(exc)})
    for name, getter, _setter in decoder.options:
        try:
            value = getter()
            if not isinstance(value, (str, bool, int, float, type(None))) or isinstance(value, float) and not math.isfinite(value):
                raise TypeError('Option getter did not return a finite JSON scalar')
            result['values'][name] = value
            if value is None or isinstance(value, str) and value.lower() == 'unknown':
                result['unknownFields'].append(name)
        except Exception as exc:
            result['values'][name] = None
            result['errors'].append({'field': name, 'error': type(exc).__name__, 'message': str(exc)})
    if 'low_voltage_threshold' in result['values']:
        result['fieldMetadata']['low_voltage_threshold'] = {'unit': 'encoding', 'volts': None, 'mapping': 'unverified-for-model'}
    if 'rstout_por_state' in result['values']:
        result['fieldMetadata']['rstout_por_state'] = {'physicalPin': None, 'mapping': 'unverified-for-model'}
    try:
        enrich_official_options(protocol, result)
    except Exception as exc:
        result['errors'].append({'field': 'fieldMetadata', 'error': type(exc).__name__, 'message': str(exc)})
    result['ok'] = not result['errors']
    return result


def chip_info(protocol):
    return {"model": protocol.model.name, "magic": f"{protocol.mcu_magic:04X}", "bslVersion": protocol.mcu_bsl_version, "freqHz": round(protocol.mcu_clock_hz), "codeBytes": protocol.model.code, "uid": protocol.uid.hex().upper() if protocol.uid else None, 'hardwareOptions': hardware_options(protocol)}


def connect_status(protocol):
    """Receive STC status without reconfiguring Windows COM state afterward.

    Derived from stcgal's MIT-licensed connect sequence. Configure the UART
    before sync; defer longer programming timeouts until after the handshake.
    """
    import serial
    from stcgal.protocols import StcFramingException, StcProtocolException
    protocol.ser = serial.Serial(port=protocol.port, baudrate=protocol.baud_handshake,
                                 parity=protocol.PARITY, timeout=0.5,
                                 inter_byte_timeout=0.5, write_timeout=3)
    protocol.ser.flushInput()
    print('Waiting for MCU, please cycle power: ', end='', flush=True)
    protocol.status_packet = None
    while protocol.status_packet is None:
        try:
            protocol.pulse()
            status = protocol.get_status_packet()
            if len(status) < 23:
                raise StcProtocolException('status packet too short')
            protocol.status_packet = status
        except (StcFramingException, serial.SerialTimeoutException):
            continue
    protocol.initialize_model()
    print('done', flush=True)


def bounded_connect(protocol, seconds, connect=None):
    # Upstream connect retries invalid frames forever. Bound the whole sync,
    # including repeated garbage from an already running application.
    deadline = time.monotonic() + seconds
    original = protocol.pulse
    reconnects = []
    protocol.connection_diagnostics = reconnects
    opened = False
    connect = connect or protocol.connect

    def pulse(character=b"\x7f", timeout=0):
        nonlocal opened
        opened = True
        local_deadline = min(deadline, time.monotonic() + timeout) if timeout else deadline
        while time.monotonic() < local_deadline:
            protocol.ser.write(character)
            protocol.ser.flush()
            time.sleep(0.03)
            if protocol.ser.in_waiting:
                return
        raise IspError("BOOTLOADER_TIMEOUT", "没有收到有效 BSL 应答；请按下载键或冷启动 MCU，应用程序遥测不是 ISP 握手。")

    protocol.pulse = pulse
    try:
        from serial import SerialException
        while True:
            try:
                connect()
                return
            except SerialException as exc:
                # Opening a busy/nonexistent port initially must fail visibly.
                # A port that disappeared after opening may be the same USB
                # interface losing power during MCU cold-start. Reopen only
                # during sync, before any erase/programming action is possible.
                if not opened:
                    raise
                reconnects.append(str(exc))
                handle = getattr(protocol, "ser", None)
                if handle is not None:
                    try:
                        handle.close()
                    except SerialException as close_error:
                        reconnects.append("close: " + str(close_error))
                if time.monotonic() >= deadline:
                    raise IspError("BOOTLOADER_TIMEOUT", "串口在冷启动后未恢复：" + str(exc)) from exc
                time.sleep(0.25)
    finally:
        protocol.pulse = original


def load_image(spec):
    from stcgal.ihex import IHex
    raw = memory_applications().file_path(spec["hex"]).read_bytes()
    if hashlib.sha256(raw).hexdigest() != spec.get("expectedSha256"):
        raise IspError("HEX_CHANGED", "HEX 在预检后发生变化，请重新预检。")
    return IHex.read(io.BytesIO(raw)).extract_data()


def validate_image_binding_request(spec):
    if 'imageBinding' not in spec:
        return None
    binding = spec['imageBinding']
    if (spec.get('action') != 'flash' or not isinstance(binding, dict)
            or set(binding) != {'schemaVersion', 'imageId', 'buffer', 'hexSha256', 'denseSha256', 'denseBytes'}
            or type(binding.get('schemaVersion')) is not int or binding['schemaVersion'] != 1 or binding.get('buffer') != 'code'
            or not all(isinstance(binding.get(key), str) and re.fullmatch(r'[0-9a-f]{64}', binding[key])
                       for key in ('imageId', 'hexSha256', 'denseSha256'))
            or type(binding.get('denseBytes')) is not int or not 1 <= binding['denseBytes'] <= 65536
            or binding.get('hexSha256') != spec.get('expectedSha256')):
        raise IspError('INVALID_IMAGE_BINDING', 'Invalid bound image identity/size/file hash; no serial access')
    return binding


def validate_application_request(spec):
    intent = spec.get('optionsApplication')
    if intent is None:
        if spec.get('applicationId') is not None:
            raise IspError('INVALID_APPLICATION_PLAN', 'Application ID without intent')
        return None
    if not isinstance(intent, dict) or not isinstance(spec.get('applicationId'), str):
        raise IspError('INVALID_APPLICATION_PLAN', 'Application requires intent and ID')
    encoded = json.dumps(intent, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    if hashlib.sha256(encoded).hexdigest() != spec['applicationId']:
        raise IspError('APPLICATION_ID_MISMATCH', 'Application intent hash mismatch; no serial access')
    baseline, image = intent.get('baseline'), intent.get('image')
    if (intent.get('method') != 'reflash-code' or intent.get('profileId') != 'stc15-f449-725s-v2'
            or not isinstance(baseline, dict) or not isinstance(image, dict)
            or baseline.get('model') != 'IAP15F2K61S2' or baseline.get('magic') != 'F449'
            or baseline.get('bslVersion') != '7.2.5S' or baseline.get('codeBytes') != 62464
            or set(baseline) != {'model', 'magic', 'bslVersion', 'freqHz', 'codeBytes', 'rawMsrHex'}
            or type(baseline.get('freqHz')) is not int or not 100000 <= baseline['freqHz'] <= 40000000
            or not isinstance(baseline.get('rawMsrHex'), str) or not re.fullmatch(r'[0-9a-f]{2}( [0-9a-f]{2}){4}', baseline['rawMsrHex'])
            or not isinstance(intent.get('afterMsrHex'), str) or not re.fullmatch(r'[0-9a-f]{2}( [0-9a-f]{2}){4}', intent['afterMsrHex'])
            or not isinstance(intent.get('patch'), dict) or not intent['patch']):
        raise IspError('INVALID_APPLICATION_PLAN', 'Unsupported application profile or incomplete baseline')
    if (spec.get('action') != 'flash' or spec.get('protocol') != 'stc15' or spec.get('mcu') != baseline['model']
            or spec.get('clockMode', 'calibrate') != 'calibrate' or spec.get('port') != intent.get('port')
            or not isinstance(intent.get('port'), str) or not re.fullmatch(r'COM[1-9][0-9]*', intent['port'])
            or spec.get('hex') != image.get('path') or spec.get('expectedSha256') != image.get('sha256')
            or not isinstance(image.get('sha256'), str) or not re.fullmatch(r'[0-9a-f]{64}', image['sha256'])
            or type(intent.get('requestedFreqHz')) is not int or not 100000 <= intent['requestedFreqHz'] <= 40000000
            or spec.get('freqHz') != intent['requestedFreqHz']):
        raise IspError('INVALID_APPLICATION_PLAN', 'Execution parameters do not match prepared intent')
    if (type(image.get('imageBytes')) is not int or type(image.get('paddedBytes')) is not int
            or not 0 < image['imageBytes'] <= 62464 or image['paddedBytes'] != ((image['imageBytes'] + 511) // 512) * 512
            or image['paddedBytes'] > 62464):
        raise IspError('INVALID_APPLICATION_PLAN', 'Invalid bound image sizes')
    return intent


def merge_application_patch(protocol, chip, intent):
    from stcgal.options import Stc15Option
    actual = {key: chip[key] for key in ['model', 'magic', 'bslVersion', 'freqHz', 'codeBytes']}
    actual['rawMsrHex'] = chip['hardwareOptions']['rawMsrHex']
    if actual != intent['baseline']:
        raise IspError('APPLICATION_BASELINE_CHANGED', 'Live MCU status differs from prepared baseline; no calibration or erase')
    if getattr(protocol, 'external_clock', True) or chip['hardwareOptions']['decoder'] != 'stcgal-1.10/Stc15Option':
        raise IspError('APPLICATION_CLOCK_UNAVAILABLE', 'Application requires the internal-IRC STC15 decoder')
    decoder = Stc15Option(bytes.fromhex(actual['rawMsrHex']))
    declared = {name: (getter, setter) for name, getter, setter in decoder.options if name != 'cpu_core_voltage'}
    enums = {'clock_source': ['internal'], 'clock_gain': ['low', 'high'], 'por_reset_delay': ['short', 'long'],
             'rstout_por_state': ['low', 'high'], 'uart2_pin_mode': ['normal', 'push-pull']}
    try:
        for name, value in intent['patch'].items():
            if name not in declared:
                raise ValueError('Unknown or unverified option: ' + name)
            getter, setter = declared[name]
            if type(value) is not type(getter()) or name in enums and value not in enums[name]:
                raise ValueError('Invalid strict type or enum: ' + name)
            if name == 'uart2_pin_mode':
                # stcgal1.10 treats both nonempty strings as true; use verified bit semantics.
                decoder.msr[2] = (decoder.msr[2] & 0xdf) | (0x20 if value == 'push-pull' else 0)
            elif name == 'rstout_por_state':
                setter(value == 'high')
            else:
                setter(str(value) if type(value) is int else value)
    except (ValueError, TypeError) as error:
        raise IspError('APPLICATION_PATCH_INVALID', str(error)) from error
    after = bytes(decoder.get_msr())
    if after.hex(' ') != intent['afterMsrHex'] or after.hex(' ') == actual['rawMsrHex']:
        raise IspError('APPLICATION_PATCH_INVALID', 'Patch does not match prepared MSR or has no changes')
    return after


def application_options_payload(protocol, msr):
    from stcgal.options import Stc15Option
    from stcgal.protocols import Stc15Protocol
    state = SimpleNamespace(options=Stc15Option(msr), trim_frequency=protocol.trim_frequency, trim_value=protocol.trim_value)
    data = Stc15Protocol.build_options(state)
    if len(data) != 64 or bytes(data[index] for index in [61, 62, 63, 31, 55]) != msr:
        raise IspError('APPLICATION_PACKET_INVALID', 'Built option payload differs from validated MSR')
    return bytes.fromhex('04 00 00 5a a5') + data


def factory_baud_handshake(protocol):
    """STC15B factory 24MHz download clock; preserve user option Flash.

    Packet fields cross-checked against IOsetting/stc8prog's STC15B protocol
    table and baudrate_set(). No calibration or option-write commands occur.
    https://github.com/IOsetting/stc8prog/blob/main/src/stc8db.c
    """
    from stcgal.protocols import StcProtocolException
    if protocol.bsl_version < 0x72 or protocol.external_clock:
        raise IspError("UNSUPPORTED_CLOCK_MODE", "保留配置快速下载仅适配内部 IRC 的 STC15 BSL 7.2+")
    reload_value = 65536 - int(24_000_000 / 4 / protocol.baud_transfer)
    packet = bytes([0x01, protocol.freq_count_24, 0x40]) + struct.pack(">H", reload_value) + bytes([0x00, 0x00, 0xC3])
    protocol.write_packet(packet)
    response = protocol.read_packet()
    if not response or response[0] != 0x01:
        raise StcProtocolException("factory clock switch was not acknowledged")
    protocol.ser.baudrate = protocol.baud_transfer
    time.sleep(0.01)
    protocol.write_packet(bytes([0x05, 0x00, 0x00, 0x5A, 0xA5]))
    response = protocol.read_packet()
    if not response or response[0] != 0x05:
        raise StcProtocolException("download baudrate check was not acknowledged")


def calibrate_stc15_725s(protocol):
    """Narrow IAP15F2K61S2/7.2.5S profile from the observed COM9 transaction.

    Range/trim selection follows the MIT stcgal algorithm, with coarse count11,
    integer interpolation and 92 measurement pulses seen in official6.75.
    No erase or option-write command occurs here. User trim is always selected
    from measured responses, never copied from one board's captured constants.
    """
    from stcgal.protocols import StcProtocolException
    requested = protocol.trim_frequency or protocol.mcu_clock_hz
    program_hz = 22_118_400
    scale = protocol.baud_handshake / 2
    user_target, program_target = requested / scale, program_hz / scale
    coarse = bytes.fromhex('00 0b 00 c0 80 c0 ff c0 00 80 80 80 ff 80 00 40 80 40 ff 40 00 00 80 00 00 00')

    def measure(packet, count):
        protocol.write_packet(packet)
        protocol.pulse(b'\x92', timeout=2.0)
        response = protocol.read_packet()
        if len(response) < 2 or response[0] != 0 or response[1] != count or len(response) < 2 + 2 * count:
            raise StcProtocolException('invalid STC15 calibration response')
        return list(struct.unpack('>' + 'H' * count, response[2:2+2*count]))

    counts = measure(coarse, 11)
    candidates = list(zip(coarse[2::2], coarse[3::2]))[:11]

    def neighborhood(target):
        for index in range(len(counts) - 1):
            low, high = counts[index:index+2]
            trim_a, range_a = candidates[index]
            trim_b, range_b = candidates[index+1]
            if range_a == range_b and low != high and min(low, high) <= target <= max(low, high):
                center = int(trim_a + (target - low) * (trim_b - trim_a) / (high - low))
                center = max(3, min(253, center))
                return [(trim, range_a) for trim in range(center - 3, center + 3)]
        raise StcProtocolException('requested frequency is outside measured STC15 calibration ranges')

    trials = neighborhood(user_target) + neighborhood(program_target)
    fine = bytes([0, 12]) + b''.join(bytes(candidate) for candidate in trials)
    fine_counts = measure(fine, 12)
    user_index = min(range(6), key=lambda i: abs(fine_counts[i] - user_target))
    program_index = min(range(6, 12), key=lambda i: abs(fine_counts[i] - program_target))
    user_trim, program_trim = trials[user_index], trials[program_index]
    actual_hz = round(fine_counts[user_index] * scale)
    if abs(actual_hz - requested) / requested > 0.02:
        raise StcProtocolException('calibrated user frequency differs by more than 2%; refusing erase')
    protocol.trim_value = user_trim
    protocol.trim_frequency = actual_hz
    # The captured 22MHz download clock uses conservative IAP delay82.
    reload_value = int(65536 - program_hz / (protocol.baud_transfer * 4))
    packet = bytes([1, *program_trim]) + struct.pack('>H', reload_value) + bytes(reversed(user_trim)) + bytes([0x82])
    protocol.write_packet(packet)
    response = protocol.read_packet()
    if not response or response[0] != 1:
        raise StcProtocolException('STC15 calibrated baud switch was not acknowledged')
    time.sleep(0.2)
    protocol.ser.baudrate = protocol.baud_transfer
    protocol.calibration_report = {'profile': 'iap15f2k61s2-7.2.5s', 'requestedFreqHz': requested,
                                   'actualFreqHz': actual_hz, 'userTrim': list(user_trim),
                                   'programTrim': list(program_trim), 'pulseHex': '92'}


def programming_timeouts(handle):
    """Change read timeouts without reapplying DCB/control-line state on Windows.

    pyserial3.5's timeout properties call _reconfigure_port(), including
    SetCommState. An established ISP session only needs SetCommTimeouts here.
    """
    if sys.platform == 'win32' and hasattr(handle, '_port_handle'):
        import ctypes
        from serial import win32
        timeouts = win32.COMMTIMEOUTS()
        timeouts.ReadIntervalTimeout = 1000
        timeouts.ReadTotalTimeoutConstant = 15000
        write_timeout = getattr(handle, 'write_timeout', 3)
        if write_timeout is not None:
            timeouts.WriteTotalTimeoutConstant = win32.MAXDWORD if write_timeout == 0 else max(1, int(write_timeout * 1000))
        if not win32.SetCommTimeouts(handle._port_handle, ctypes.byref(timeouts)):
            raise IspError('TIMEOUT_CONFIG_FAILED', 'SetCommTimeouts failed: ' + str(win32.GetLastError()))
        handle._timeout = 15.0
        handle._inter_byte_timeout = 1.0
    else:
        handle.timeout = 15.0
        handle.interCharTimeout = 1.0


def run_session(spec, factory=None, emit=emit_event):
    try:
        spec = session_parameters().normalize_isp(spec)
    except Exception as error:
        return parameter_failure(spec, error)
    use_status_connection = factory is None and sys.platform == 'win32'
    if factory is None:
        from stcgal.frontend import StcGal
        factory = StcGal
    stage = "preflight"
    gal = None
    chip = None
    programmed = False
    program_acknowledged = False
    erase_started = False
    options_write_started = False
    options_acknowledged = False
    options_write = None
    image_binding = None
    bound_image_verified = False
    erase_reception = None
    prepared_erase = None
    cleanup_errors = []
    timing = []
    started = time.perf_counter()
    restore_serial_config = None
    if spec.get('debug') and sys.platform == 'win32':
        import serial
        original_config = serial.Serial._reconfigure_port
        def timed_config(handle):
            begin = time.perf_counter()
            try:
                return original_config(handle)
            finally:
                timing.append({'kind': 'serial_config', 'tMs': round((begin-started)*1000, 3), 'durationMs': round((time.perf_counter()-begin)*1000, 3), 'baud': handle.baudrate, 'timeout': handle.timeout})
        serial.Serial._reconfigure_port = timed_config
        restore_serial_config = lambda: setattr(serial.Serial, '_reconfigure_port', original_config)

    def at(value):
        nonlocal stage
        stage = value
        emit({"event": "stage", "stage": stage})

    try:
        action = spec["action"]
        if action not in ("flash", "chipinfo", "handshake"):
            raise IspError("BAD_ACTION", "Only flash, chipinfo and diagnostic handshake are supported")
        if action == "flash" and not spec.get("mcu"):
            raise IspError("MCU_REQUIRED", "Flash requires an expected MCU model")
        memory = None
        if 'memoryApplication' in spec:
            memory = memory_applications()
            application = memory.validate_request(spec)
        else:
            application = validate_application_request(spec)
        image_binding = validate_image_binding_request(spec)
        image = load_image(spec) if action == "flash" else None
        if image_binding:
            if len(image) != image_binding['denseBytes'] or hashlib.sha256(image).hexdigest() != image_binding['denseSha256']:
                raise IspError('IMAGE_BYTES_CHANGED', 'Decoded HEX bytes do not match bound image; no serial access')
            bound_image_verified = True
        if memory:
            recovery = application['codeRecovery']
            memory.validate_bytes(application, image, load_image({'hex': recovery['path'], 'expectedSha256': recovery['sha256']}))
        if application and not memory and len(image) != application['image']['imageBytes']:
            raise IspError('APPLICATION_IMAGE_CHANGED', 'Decoded image length differs from bound application')
        trim_khz = float(spec.get("freqHz") or 0) / 1000 if spec["protocol"] in ("stc15", "stc15a") else 0.0
        opts = SimpleNamespace(protocol=spec["protocol"], port=spec["port"], handshake=2400, baud=spec.get("baud", 115200), trim=trim_khz, debug=bool(spec.get("debug")))
        gal = factory(opts)
        if spec.get('debug'):
            original_dump = gal.protocol.dump_packet
            def timed_dump(data, receive=True):
                if len(data) > 5 and data.startswith(b'\x46\xb9'):
                    timing.append({'kind': 'rx' if receive else 'tx', 'tMs': round((time.perf_counter()-started)*1000, 3), 'hex': data.hex(' ')})
                return original_dump(data, receive)
            gal.protocol.dump_packet = timed_dump
        at("waiting_for_bootloader")
        bounded_connect(gal.protocol, float(spec.get("waitSeconds", 60)),
                        connect=(lambda: connect_status(gal.protocol)) if use_status_connection else None)
        base = None
        if spec["protocol"] == "auto":
            base = gal.protocol
            detected = base.protocol_name
            if detected not in ("stc89", "stc89a", "stc15", "stc15a"):
                raise IspError("UNSUPPORTED_PROTOCOL", f"Unverified protocol: {detected}")
            opts.protocol = detected
            gal.initialize_protocol(opts)
        at("identify")
        gal.protocol.initialize(base)
        chip = chip_info(gal.protocol)
        if not chip['hardwareOptions']['ok']:
            raise IspError('OPTION_DECODE_FAILED', 'Hardware-option decoding failed; no erase or option writes: ' +
                           ', '.join(error['field'] for error in chip['hardwareOptions']['errors']))
        if (chip['magic'] == 'F449' and chip['bslVersion'] == '7.2.5S'
                and opts.protocol == 'stc15' and not getattr(gal.protocol, 'external_clock', True)):
            gal.protocol.calibrate = lambda: calibrate_stc15_725s(gal.protocol)
            # This BSL's observed programming requests carry128 data bytes;
            # stcgal1.10 otherwise inherits64 from the earlier STC15A family.
            gal.protocol.PROGRAM_BLOCKSIZE = 128
        expected = spec.get("mcu")
        if expected and expected.upper() not in chip["model"].upper().split("/"):
            raise IspError("MCU_MISMATCH", f"期望 {expected}，实际 {chip['model']}；未擦写 Flash。")
        if 'expectedUid' in spec:
            erase_reception, prepared_erase = erase_receivers().prepare(gal.protocol, spec['expectedUid'])
        pending_msr = None
        if application:
            at('validate_application_baseline')
            pending_msr = memory.validate_baseline(gal.protocol, chip, application) if memory else merge_application_patch(gal.protocol, chip, application)
        preserve_options = spec.get("clockMode") == "preserve"
        if preserve_options:
            if opts.protocol != "stc15":
                raise IspError("UNSUPPORTED_CLOCK_MODE", "保留配置快速下载目前仅适配 STC15")
            requested = spec.get("freqHz")
            if requested and abs(chip["freqHz"] - requested) / requested > 0.02:
                raise IspError("FREQUENCY_MISMATCH", "保留配置模式不能改频率：芯片现有频率与工程不一致；未擦写。")
        do_handshake = lambda: factory_baud_handshake(gal.protocol) if preserve_options else gal.protocol.handshake()
        if action == "handshake":
            at("handshake")
            do_handshake()
        if action == "flash":
            code_size = gal.protocol.model.code
            padded = image + b"\xff" * ((-len(image)) % 512)
            if not image or len(padded) > code_size:
                raise IspError("FLASH_OVERFLOW", f"镜像（含填充）{len(padded)} 字节，代码区 {code_size} 字节；拒绝截断。")
            freq = spec.get("freqHz")
            if opts.protocol.startswith("stc89") and freq and abs(chip["freqHz"] - freq) / freq > 0.02:
                raise IspError("FREQUENCY_MISMATCH", f"晶振实测 {chip['freqHz']} Hz 与工程 {freq} Hz 不一致；未擦写 Flash。")
            gal.protocol.progress_cb = lambda current, written, maximum: None
            at("handshake")
            do_handshake()
            pending_options_payload = application_options_payload(gal.protocol, pending_msr) if application else None
            # Acknowledged programming mode is established. Long erase reads
            # need longer timeouts; do not incur this COM reconfigure during
            # the short status-to-first-command window.
            programming_timeouts(gal.protocol.ser)
            at("erase")
            erase_started = True
            (prepared_erase or gal.protocol.erase_flash)(len(padded), code_size)
            at("program")
            gal.protocol.program_flash(padded)
            program_acknowledged = True
            if preserve_options:
                at("preserve_options")
            else:
                at("options")
                options_write_started = True
                if application:
                    options_write = {'msrHex': pending_msr.hex(' '), 'beforeMsrHex': application['baseline']['rawMsrHex'],
                                     'payloadHex': pending_options_payload.hex(' '), 'acknowledged': False,
                                     'verification': 'bootloader-ack; not status readback'}
                    gal.protocol.write_packet(pending_options_payload)
                    response = gal.protocol.read_packet()
                    options_write['responseHex'] = response.hex(' ')
                    if len(response) < 2 or response[:2] != b'\x04\x54':
                        raise IspError('OPTIONS_ACK_INVALID', 'Option write attempt was not acknowledged; state is unconfirmed')
                    options_write['acknowledged'] = True
                else:
                    gal.protocol.program_options()
                options_acknowledged = True
            chip = chip_info(gal.protocol)
            programmed = True
        at("disconnect")
        gal.protocol.disconnect()
        at("complete")
        return {"event": "result", "ok": True, "action": action, "stage": stage, "programmed": programmed, "programAcknowledged": program_acknowledged, "eraseStarted": erase_started, "eraseReception": erase_reception, "hardwareOptionsWriteStarted": options_write_started, "hardwareOptionsWritten": options_acknowledged, "optionsWrite": options_write, "applicationId": spec.get('applicationId'), "imageBinding": image_binding, "boundImageVerified": bound_image_verified, "chip": chip, "calibration": getattr(gal.protocol, 'calibration_report', None), "timing": timing, "cleanupErrors": cleanup_errors, "connectionDiagnostics": getattr(gal.protocol, "connection_diagnostics", []), "verification": {"method": "bootloader-ack" if programmed else "download-handshake" if action == "handshake" else "status-packet", "independentReadback": False}, "requestedFreqHz": spec.get("freqHz"), "nextAction": "应用已收到协议确认；需另一次冷启动只读查询核对选项。" if application else "可用 mcu_serial 验证固件运行。" if programmed else "Flash 未擦写。"}
    except Exception as exc:
        residual = None
        if spec.get("debug") and gal is not None and getattr(getattr(gal.protocol, "ser", None), "is_open", False):
            try:
                time.sleep(0.1)
                residual = gal.protocol.ser.read(min(4096, gal.protocol.ser.in_waiting)).hex(" ")
            except Exception as debug_error:
                cleanup_errors.append("diagnostic read: " + str(debug_error))
        recovery = "选项已收到确认，但后续步骤失败；先冷启动只读核对，不应视作未写入。" if options_acknowledged else "选项写入已尝试，状态未确认；先冷启动只读核对，不要自动重试。" if options_write_started else "擦写已开始，固件可能不完整，请重新烧录。" if erase_started else "核对端口与型号，开始等待后按下载键或冷启动 MCU。"
        if stage == 'erase' and erase_reception is not None:
            recovery = '已发出擦除请求，代码区可能已擦除；停止后续写入，核对实际目标和原始回执，不自动重试。'
        return {"event": "result", "ok": False, "programmed": False, "programAcknowledged": program_acknowledged, "eraseStarted": erase_started, "eraseReception": erase_reception, "hardwareOptionsWriteStarted": options_write_started, "hardwareOptionsWritten": options_acknowledged, "optionsWrite": options_write, "applicationId": spec.get('applicationId'), "imageBinding": image_binding, "boundImageVerified": bound_image_verified, "stage": stage, "chip": chip, "error": getattr(exc, "code", type(exc).__name__), "message": str(exc), "timing": timing, "cleanupErrors": cleanup_errors, "connectionDiagnostics": getattr(gal.protocol, "connection_diagnostics", []) if gal else [], "residualRxHex": residual, "nextAction": recovery}
    finally:
        if restore_serial_config is not None:
            restore_serial_config()
        if gal is not None:
            ser = getattr(gal.protocol, "ser", None)
            if ser is not None and ser.is_open:
                try:
                    ser.close()
                except Exception as close_error:
                    cleanup_errors.append("close: " + str(close_error))


@functools.lru_cache(maxsize=1)
def erase_receivers():
    spec = importlib.util.spec_from_file_location('dsh_erase_receiver', Path(__file__).with_name('erase_receiver.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@functools.lru_cache(maxsize=1)
def memory_applications():
    spec = importlib.util.spec_from_file_location('dsh_memory_application', Path(__file__).with_name('memory_application.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@functools.lru_cache(maxsize=1)
def port_sessions():
    spec = importlib.util.spec_from_file_location('dsh_port_session', Path(__file__).with_name('port_session.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_locked_session(spec, emit=emit_event, worker=run_session, lease_factory=None):
    try:
        spec = session_parameters().normalize_isp(spec)
    except Exception as error:
        return parameter_failure(spec, error)
    result = port_sessions().run_exclusive(spec.get('port'), 'isp:' + str(spec.get('action')), lambda: worker(spec, emit=emit),
                                           lease_factory=lease_factory,
                                           on_acquired=lambda info: emit({'event': 'session-acquired', 'session': info}))
    result.setdefault('event', 'result')
    result.setdefault('action', spec.get('action'))
    result.setdefault('applicationId', spec.get('applicationId'))
    return result


@functools.lru_cache(maxsize=1)
def session_parameters():
    spec = importlib.util.spec_from_file_location('dsh_session_parameters', Path(__file__).with_name('session_parameters.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def parameter_failure(request, error):
    request = request if isinstance(request, dict) else {}
    return {'event': 'result', 'ok': False, 'error': getattr(error, 'code', 'BAD_SESSION_PARAMETERS'), 'message': str(error),
            'stage': 'preflight', 'hardwareAccess': False, 'programmed': False, 'eraseStarted': False,
            'programAcknowledged': False, 'hardwareOptionsWriteStarted': False, 'hardwareOptionsWritten': False,
            'action': request.get('action'), 'applicationId': request.get('applicationId')}


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    try:
        spec = json.loads(sys.stdin.buffer.read().decode("utf-8"))
        output = sys.stdout
        with contextlib.redirect_stdout(sys.stderr):
            result = run_locked_session(spec, emit=lambda event: print(json.dumps(event, ensure_ascii=False), file=output, flush=True))
    except Exception as exc:
        result = {"event": "result", "ok": False, "stage": "startup", "error": type(exc).__name__, "message": str(exc)}
    emit_event(result)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
