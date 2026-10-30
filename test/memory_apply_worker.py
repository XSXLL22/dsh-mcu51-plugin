"""Request-driven replay worker called by Node tests, not a discoverable test module. No real COM."""
import contextlib
import hashlib
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_options_apply import FIXTURE, isp, CaptureTransport, packet, ROOT


def transport(image, ack=True):
    value = CaptureTransport()
    value._port_handle = 123
    value.exchanges.append((packet(0x6a, bytes.fromhex('03 00 00 5a a5')), packet(0x68, bytes.fromhex('03 00 11 22 33 44 55 66'))))
    for offset in range(0, len(image), 128):
        command = bytes([0x22 if offset == 0 else 2]) + offset.to_bytes(2, 'big') + bytes.fromhex('5a a5') + image[offset:offset + 128]
        value.exchanges.append((packet(0x6a, command), packet(0x68, b'\x02\x54')))
    value.exchanges.append((packet(0x6a, bytes.fromhex('07 00 00 5a a5')), packet(0x68, b'\x07\x54')))
    data = bytearray.fromhex(FIXTURE['engineDataHex'])
    for index, byte in zip([61, 62, 63, 31, 55], bytes.fromhex('f7 bb 9f fd ff')):
        data[index] = byte
    value.exchanges.append((packet(0x6a, bytes.fromhex('04 00 00 5a a5') + data), packet(0x68, b'\x04\x54' if ack else b'\x04\x00')))
    return value


def bind(spec):
    spec['applicationId'] = hashlib.sha256(json.dumps(spec['memoryApplication'], sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


def replay(spec, handle):
    # Real HEX decoder, real protocol and calibrator, captured responses; no serial device.
    with patch('serial.Serial', return_value=handle), patch('serial.win32.SetCommTimeouts', return_value=True), \
            patch.object(isp.time, 'sleep', return_value=None), contextlib.redirect_stdout(io.StringIO()):
        return isp.run_session(spec, emit=lambda event: None)


class MemoryReplayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.spec = json.loads(Path(REQUEST).read_text(encoding='utf-8'))
        cls.image = isp.load_image(cls.spec)

    def request(self):
        return json.loads(json.dumps(self.spec))

    def test_complete_combined_replay(self):
        handle = transport(self.image)
        result = replay(self.request(), handle)
        self.assertTrue(result['ok'], result)
        self.assertTrue(result['programAcknowledged']); self.assertTrue(result['boundImageVerified'])
        self.assertEqual(result['applicationId'], self.spec['applicationId'])
        self.assertEqual(result['imageBinding'], self.spec['imageBinding'])
        self.assertEqual(result['optionsWrite']['msrHex'], 'f7 bb 9f fd ff')
        self.assertFalse(result['verification']['independentReadback'])
        self.assertEqual(handle.command_index, len(handle.exchanges))
        self.assertEqual(handle.config_after_prepare, [])
        self.assertFalse(handle.is_open)

    def test_live_msr_and_frequency_change_stops_before_calibration(self):
        for field, changed in [('freqHz', 12000000), ('rawMsrHex', 'f6 bb 9f fd ff')]:
            spec = self.request(); spec['memoryApplication']['baseline'][field] = changed; bind(spec)
            handle = transport(self.image); result = replay(spec, handle)
            self.assertFalse(result['ok']); self.assertEqual(result['error'], 'MEMORY_BASELINE_CHANGED')
            self.assertFalse(result['eraseStarted']); self.assertEqual(handle.command_index, 0)

    def test_invalid_intent_parameters_or_hash_never_construct_transport(self):
        mutations = [lambda s: s.update(applicationId='0' * 64), lambda s: s.update(port='COM8'),
                     lambda s: s.update(optionsApplication={}), lambda s: s['memoryApplication']['tailPolicy'].update(programmingEndExclusive=62464),
                     lambda s: s['memoryApplication']['baseline'].update(rawMsrHex='f7 bb 9f ff ff'),
                     lambda s: s['imageBinding'].update(denseSha256='0' * 64),
                     lambda s: s['memoryApplication']['preview']['options'].update(targetId='stc675:0')]
        for index, change in enumerate(mutations):
            spec = self.request(); change(spec)
            if index: bind(spec)
            result = isp.run_session(spec, factory=lambda opts: self.fail('must not construct transport'), emit=lambda event: None)
            self.assertFalse(result['ok']); self.assertFalse(result['eraseStarted'])

    def test_rehashed_wrong_data_range_or_recovery_bytes_never_open_serial(self):
        for field in ['data', 'codeRecovery']:
            spec = self.request()
            if field == 'data' and spec['memoryApplication']['data'] is None:
                continue  # A separate combined-image replay covers the data hash.
            if field == 'data': spec['memoryApplication']['data']['sha256'] = '0' * 64
            else: spec['memoryApplication']['codeRecovery']['denseSha256'] = '0' * 64
            bind(spec)
            result = isp.run_session(spec, factory=lambda opts: self.fail('must not construct transport'), emit=lambda event: None)
            self.assertFalse(result['ok']); self.assertEqual(result['error'], 'MEMORY_BYTES_CHANGED')

    def test_options_ack_loss_preserves_partial_write_flags(self):
        result = replay(self.request(), transport(self.image, ack=False))
        self.assertFalse(result['ok']); self.assertEqual(result['error'], 'OPTIONS_ACK_INVALID')
        self.assertTrue(result['eraseStarted']); self.assertTrue(result['programAcknowledged'])
        self.assertTrue(result['hardwareOptionsWriteStarted']); self.assertFalse(result['hardwareOptionsWritten'])

    def test_mid_program_failure_preserves_erase_without_claiming_complete_program(self):
        handle = transport(self.image)
        # Four handshake commands, erase, then the first programming block.
        expected, _ = handle.exchanges[5]
        handle.exchanges[5] = (expected, packet(0x68, b'\x02\x00'))
        result = replay(self.request(), handle)
        self.assertFalse(result['ok']); self.assertEqual(result['stage'], 'program')
        self.assertTrue(result['eraseStarted']); self.assertFalse(result['programAcknowledged'])
        self.assertFalse(result['hardwareOptionsWriteStarted']); self.assertFalse(handle.is_open)

    def test_disconnect_failure_does_not_hide_acknowledged_code_and_options(self):
        with patch('stcgal.protocols.Stc15Protocol.disconnect', side_effect=RuntimeError('exit lost')):
            result = replay(self.request(), transport(self.image))
        self.assertFalse(result['ok']); self.assertEqual(result['stage'], 'disconnect')
        self.assertTrue(result['programAcknowledged']); self.assertTrue(result['hardwareOptionsWritten'])

    def test_gap_and_padding_require_ff_even_with_a_rehashed_dense_buffer(self):
        memory = isp.memory_applications()
        recovery = isp.load_image({'hex': self.spec['memoryApplication']['codeRecovery']['path'],
                                   'expectedSha256': self.spec['memoryApplication']['codeRecovery']['sha256']})
        for position in [len(recovery), len(self.image) - 1]:
            spec = self.request(); image = bytearray(self.image); image[position] = 0
            spec['memoryApplication']['image']['denseSha256'] = hashlib.sha256(image).hexdigest()
            with self.assertRaises(memory.MemoryError) as error:
                memory.validate_bytes(spec['memoryApplication'], image, recovery)
            self.assertEqual(error.exception.code, 'MEMORY_BYTES_CHANGED')

    def test_bound_file_change_never_opens_serial(self):
        path = isp.memory_applications().file_path(self.spec['memoryApplication']['codeRecovery']['path'])
        before = path.read_bytes()
        try:
            path.write_bytes(before + b' ')
            result = isp.run_session(self.request(), factory=lambda opts: self.fail('must not construct transport'), emit=lambda event: None)
            self.assertFalse(result['ok']); self.assertEqual(result['error'], 'MEMORY_FILE_CHANGED')
        finally:
            path.write_bytes(before)


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] != '--request':
        raise SystemExit('usage: memory_apply_worker.py --request JS-prepared-request.json (closed replay only)')
    REQUEST = sys.argv[2]
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(MemoryReplayTests)
    report = io.StringIO()
    result = unittest.TextTestRunner(stream=report, verbosity=2).run(suite)
    print(json.dumps({'ok': result.wasSuccessful(), 'tests': result.testsRun, 'blocks': len(MemoryReplayTests.image) // 128,
                      'hardwareAccess': False, 'serialReconfigurationsAfterPrepare': 0 if result.wasSuccessful() else None,
                      'report': report.getvalue()}))
    raise SystemExit(0 if result.wasSuccessful() else 1)
