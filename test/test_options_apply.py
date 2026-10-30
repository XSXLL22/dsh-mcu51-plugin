"""Full option application replay. Synthetic code/UID; no physical COM access."""
import contextlib
import hashlib
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_stc15_capture import isp, CaptureTransport, packet, ROOT

FIXTURE = json.loads((Path(__file__).parent / 'fixtures/stc15-options-write.json').read_text(encoding='utf-8'))
IMAGE = bytes(range(256)) * 2


def bind(request):
    request['applicationId'] = hashlib.sha256(json.dumps(request['optionsApplication'], sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
    return request


def request():
    image_path = str(ROOT / 'test/fixtures/virtual-application.hex')
    intent = {'method': 'reflash-code', 'profileId': 'stc15-f449-725s-v2', 'port': 'COM9',
              'baseline': {'model': 'IAP15F2K61S2', 'magic': 'F449', 'bslVersion': '7.2.5S', 'freqHz': 11998800,
                           'codeBytes': 62464, 'rawMsrHex': 'f7 bb 9f fd ff'},
              'patch': {'watchdog_prescale': 128}, 'afterMsrHex': 'f6 bb 9f fd ff', 'requestedFreqHz': 12000000,
              'image': {'path': image_path, 'sha256': '0' * 64, 'dataBytes': 512, 'imageBytes': 512, 'paddedBytes': 512},
              'snapshotFileSha256': None}
    return bind({'action': 'flash', 'protocol': 'stc15', 'port': 'COM9', 'mcu': 'IAP15F2K61S2', 'freqHz': 12000000,
                 'clockMode': 'calibrate', 'waitSeconds': 1, 'hex': image_path, 'expectedSha256': '0' * 64, 'optionsApplication': intent})


def transport(after='f6 bb 9f fd ff', ack=True):
    value = CaptureTransport()
    value._port_handle = 123
    value.exchanges.append((packet(0x6a, bytes.fromhex('03 00 00 5a a5')), packet(0x68, bytes.fromhex('03 00 11 22 33 44 55 66'))))
    for offset in range(0, len(IMAGE), 128):
        command = bytes([0x22 if offset == 0 else 2]) + offset.to_bytes(2, 'big') + bytes.fromhex('5a a5') + IMAGE[offset:offset+128]
        value.exchanges.append((packet(0x6a, command), packet(0x68, b'\x02\x54')))
    value.exchanges.append((packet(0x6a, bytes.fromhex('07 00 00 5a a5')), packet(0x68, b'\x07\x54')))
    data = bytearray.fromhex(FIXTURE['engineDataHex'])
    for index, byte in zip([61, 62, 63, 31, 55], bytes.fromhex(after)):
        data[index] = byte
    value.exchanges.append((packet(0x6a, bytes.fromhex('04 00 00 5a a5') + data), packet(0x68, b'\x04\x54' if ack else b'\x04\x00')))
    return value


def replay(spec, handle):
    with patch('serial.Serial', return_value=handle), patch('serial.win32.SetCommTimeouts', return_value=True), \
            patch.object(isp, 'load_image', return_value=IMAGE), patch.object(isp.time, 'sleep', return_value=None), contextlib.redirect_stdout(io.StringIO()):
        return isp.run_session(spec, emit=lambda event: None)


class ApplicationReplayTests(unittest.TestCase):
    def test_application_programs_code_and_exact_requested_options_without_fake_readback(self):
        handle = transport()
        result = replay(request(), handle)
        self.assertTrue(result['ok'], result)
        self.assertTrue(result['programmed'])
        self.assertTrue(result['hardwareOptionsWritten'])
        self.assertTrue(result['optionsWrite']['acknowledged'])
        self.assertEqual(result['optionsWrite']['msrHex'], 'f6 bb 9f fd ff')
        self.assertEqual(result['chip']['hardwareOptions']['rawMsrHex'], 'f7 bb 9f fd ff')
        self.assertEqual(result['optionsWrite']['verification'], 'bootloader-ack; not status readback')
        self.assertEqual(handle.command_index, len(handle.exchanges))
        self.assertEqual(handle.config_after_prepare, [])
        self.assertFalse(handle.is_open)

    def test_stale_msr_or_frequency_stops_before_handshake_and_erase(self):
        for name, value in [('rawMsrHex', 'f6 bb 9f fd ff'), ('freqHz', 12000000)]:
            spec = request(); spec['optionsApplication']['baseline'][name] = value; bind(spec)
            handle = transport(); result = replay(spec, handle)
            self.assertFalse(result['ok'])
            self.assertEqual(result['error'], 'APPLICATION_BASELINE_CHANGED')
            self.assertFalse(result['eraseStarted'])
            self.assertEqual(handle.command_index, 0)
            self.assertFalse(handle.is_open)

    def test_uart_normal_clears_the_verified_bit_without_calling_broken_upstream_setter(self):
        spec = request()
        spec['optionsApplication']['baseline']['rawMsrHex'] = 'f7 bb bf fd ff'
        spec['optionsApplication']['patch'] = {'uart2_pin_mode': 'normal'}
        spec['optionsApplication']['afterMsrHex'] = 'f7 bb 9f fd ff'
        bind(spec)
        handle = transport(after='f7 bb 9f fd ff')
        status = bytearray(handle.status[5:-3]); status[7] = 0xbf
        handle.status = packet(0x68, status)
        with patch('stcgal.options.Stc15Option.set_uart_pin_mode', side_effect=AssertionError('broken setter must not be used')):
            result = replay(spec, handle)
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['optionsWrite']['msrHex'], 'f7 bb 9f fd ff')

    def test_invalid_application_hash_is_rejected_before_factory_or_image_load(self):
        spec = request(); spec['applicationId'] = '0' * 64
        with patch.object(isp, 'load_image') as load:
            result = isp.run_session(spec, factory=lambda opts: self.fail('must not create protocol'), emit=lambda event: None)
        self.assertFalse(result['ok'])
        self.assertEqual(result['error'], 'APPLICATION_ID_MISMATCH')
        self.assertFalse(result['eraseStarted'])
        load.assert_not_called()

    def test_bad_patch_values_and_unverified_fields_are_rejected_before_handshake(self):
        for fields in [{'watchdog_prescale': '128'}, {'watchdog_por_enabled': 1}, {'cpu_core_voltage': 'high'}, {'uart2_pin_mode': 'typo'}]:
            spec = request(); spec['optionsApplication']['patch'] = fields; bind(spec)
            handle = transport(); result = replay(spec, handle)
            self.assertFalse(result['ok'])
            self.assertEqual(result['error'], 'APPLICATION_PATCH_INVALID')
            self.assertEqual(handle.command_index, 0)
            self.assertFalse(result['eraseStarted'])

    def test_missing_options_ack_retains_program_and_write_attempt_evidence(self):
        result = replay(request(), transport(ack=False))
        self.assertFalse(result['ok'])
        self.assertTrue(result['programAcknowledged'])
        self.assertTrue(result['hardwareOptionsWriteStarted'])
        self.assertFalse(result['hardwareOptionsWritten'])
        self.assertFalse(result['optionsWrite']['acknowledged'])
        self.assertEqual(result['stage'], 'options')

    def test_option_payload_build_failure_stops_before_erase(self):
        handle = transport()
        with patch.object(isp, 'application_options_payload', side_effect=isp.IspError('APPLICATION_PACKET_INVALID', 'invalid options packet')):
            result = replay(request(), handle)
        self.assertFalse(result['ok'])
        self.assertEqual(result['error'], 'APPLICATION_PACKET_INVALID')
        self.assertFalse(result['eraseStarted'])
        self.assertFalse(result['hardwareOptionsWriteStarted'])
        self.assertEqual(handle.command_index, 4)

    def test_exit_failure_does_not_hide_an_acknowledged_options_write(self):
        with patch('stcgal.protocols.Stc15Protocol.disconnect', side_effect=RuntimeError('exit failed')):
            result = replay(request(), transport())
        self.assertFalse(result['ok'])
        self.assertTrue(result['programAcknowledged'])
        self.assertTrue(result['hardwareOptionsWritten'])
        self.assertTrue(result['optionsWrite']['acknowledged'])
        self.assertEqual(result['stage'], 'disconnect')

    def test_noop_application_and_image_length_mismatch_do_not_erase(self):
        spec = request(); spec['optionsApplication']['patch'] = {'watchdog_prescale': 256}; spec['optionsApplication']['afterMsrHex'] = 'f7 bb 9f fd ff'; bind(spec)
        result = replay(spec, transport())
        self.assertFalse(result['ok']); self.assertFalse(result['eraseStarted'])
        spec = request(); spec['optionsApplication']['image']['imageBytes'] = 513; spec['optionsApplication']['image']['paddedBytes'] = 1024; bind(spec)
        result = replay(spec, transport())
        self.assertFalse(result['ok']); self.assertFalse(result['eraseStarted'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
