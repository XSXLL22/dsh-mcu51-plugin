"""Replay real official calibration replies through the real plugin session.

Transport is simulated. This cannot establish hardware compatibility.
"""
import contextlib
import importlib.util
import io
import json
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
module_spec = importlib.util.spec_from_file_location('isp', ROOT / 'sidecar/isp.py')
isp = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(isp)
CAPTURE = json.loads((Path(__file__).parent / 'fixtures/stc15-725s-official-handshake.json').read_text(encoding='utf-8-sig'))


def packet(tag, payload):
    body = bytes([tag]) + (len(payload) + 6).to_bytes(2, 'big') + payload
    return b'\x46\xb9' + body + (sum(body) & 0xffff).to_bytes(2, 'big') + b'\x16'


class CaptureTransport:
    def __init__(self):
        self.is_open = True
        self.buffer = b''
        self.pending = None
        self.command_index = 0
        self.config_after_prepare = []
        self.pulses = []
        self.baudrate = 2400
        self.timeout = 0.5
        self.interCharTimeout = 0.5
        self.exchanges = []
        frames = CAPTURE['frames']
        self.status = bytes.fromhex(frames[0]['frameHex'])
        for index in range(1, len(frames), 2):
            command = bytes.fromhex(frames[index]['frameHex'])
            reply = bytes.fromhex(frames[index+1]['frameHex'])
            if command[5] == 0x01:
                # Closest measured user trim is A2 (count270A), while the official
                # temporary download packet used A1. Retain nearest user trim as
                # the MIT engine does; this deliberate difference needs hardware.
                altered = bytearray(command)
                altered[11] = 0xa2
                altered[-3:-1] = (sum(altered[2:-3]) & 0xffff).to_bytes(2, 'big')
                command = bytes(altered)
            self.exchanges.append((command, reply))

    @property
    def in_waiting(self): return len(self.buffer)
    @property
    def timeout(self): return self._timeout
    @timeout.setter
    def timeout(self, value):
        if self.command_index >= 4: self.config_after_prepare.append(('timeout', value))
        self._timeout = value
    @property
    def interCharTimeout(self): return self._inter_byte_timeout
    @interCharTimeout.setter
    def interCharTimeout(self, value):
        if self.command_index >= 4: self.config_after_prepare.append(('interCharTimeout', value))
        self._inter_byte_timeout = value
    def inWaiting(self): return self.in_waiting
    def flushInput(self): self.buffer = b''
    def flush(self): pass
    def close(self): self.is_open = False
    def read(self, count):
        value, self.buffer = self.buffer[:count], self.buffer[count:]
        return value
    def write(self, data):
        if data == b'\x7f' and self.command_index == 0 and not self.pending:
            self.buffer += self.status
            return len(data)
        if len(data) == 1:
            if data != bytes.fromhex(CAPTURE['pulseHex']):
                raise AssertionError('Calibration pulse differs from official success: ' + data.hex())
            self.pulses.append(data)
            if self.pending:
                self.buffer += self.pending
                self.pending = None
            return len(data)
        if data[5] == 0x82:
            return len(data)
        expected, reply = self.exchanges[self.command_index]
        if expected is None:
            if data[5:10] != bytes.fromhex('04 00 00 5a a5') or len(data[10:-3]) != 64:
                raise AssertionError('Invalid options command')
        elif data != expected:
            raise AssertionError(f'Command {self.command_index} differs from capture: {data.hex(" ")}')
        self.command_index += 1
        if data[5] == 0x00:
            self.pending = reply
        else:
            self.buffer += reply
        return len(data)


class CapturedHandshakeTests(unittest.TestCase):
    def test_success_debug_returns_exact_packet_timings_without_extra_wire_commands(self):
        transport = CaptureTransport()
        request = {'action': 'handshake', 'port': 'COM9', 'protocol': 'stc15',
                   'mcu': 'IAP15F2K61S2', 'freqHz': 12_000_000, 'waitSeconds': 1, 'debug': True}
        with patch('serial.Serial', return_value=transport), patch.object(isp.time, 'sleep', return_value=None), contextlib.redirect_stdout(io.StringIO()):
            result = isp.run_session(request, emit=lambda event: None)
        self.assertTrue(result['ok'], result)
        expected = [('rx', transport.status.hex(' '))]
        for command, reply in transport.exchanges[:4]:
            expected.extend([('tx', command.hex(' ')), ('rx', reply.hex(' '))])
        expected.append(('tx', packet(0x6a, b'\x82').hex(' ')))
        timings = result.get('timing', [])
        packets = [(event['kind'], event['hex']) for event in timings if event['kind'] in ('tx', 'rx')]
        self.assertEqual(packets, expected, 'Successful debug result must preserve all actual packet events')
        self.assertEqual([event['tMs'] for event in timings], sorted(event['tMs'] for event in timings))
        self.assertTrue(all(event['tMs'] >= 0 for event in timings))
        self.assertEqual(transport.command_index, 4)
        self.assertFalse(result['eraseStarted'])
        self.assertFalse(transport.is_open)

    def test_option_decode_failure_stops_flash_before_handshake(self):
        transport = CaptureTransport()
        request = {'action': 'flash', 'port': 'COM9', 'protocol': 'stc15',
                   'mcu': 'IAP15F2K61S2', 'freqHz': 12_000_000, 'waitSeconds': 1}
        broken = {'available': True, 'ok': False, 'errors': [{'field': 'bad_field', 'message': 'bad encoding'}]}
        with patch('serial.Serial', return_value=transport), patch.object(isp, 'hardware_options', return_value=broken), patch.object(isp, 'load_image', return_value=b'x'), patch.object(isp.time, 'sleep', return_value=None), contextlib.redirect_stdout(io.StringIO()):
            result = isp.run_session(request, emit=lambda event: None)
        self.assertFalse(result['ok'])
        self.assertEqual(result['error'], 'OPTION_DECODE_FAILED')
        self.assertFalse(result['eraseStarted'])
        self.assertEqual(transport.command_index, 0)
        self.assertEqual(result['chip']['hardwareOptions']['errors'][0]['field'], 'bad_field')
        self.assertFalse(transport.is_open)

    def test_chipinfo_returns_hardware_options_without_handshake_or_writes(self):
        transport = CaptureTransport()
        request = {'action': 'chipinfo', 'port': 'COM9', 'protocol': 'stc15',
                   'mcu': 'IAP15F2K61S2', 'waitSeconds': 1}
        with patch('serial.Serial', return_value=transport), patch.object(isp.time, 'sleep', return_value=None), contextlib.redirect_stdout(io.StringIO()):
            result = isp.run_session(request, emit=lambda event: None)
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['chip']['hardwareOptions']['rawMsrHex'], 'f7 bb 9f fd ff')
        self.assertEqual(result['chip']['hardwareOptions']['values']['low_voltage_threshold'], 3)
        metadata = result['chip']['hardwareOptions']['fieldMetadata']['low_voltage_threshold']
        self.assertEqual(metadata['volts'], 3.82)
        self.assertEqual(metadata['mapping'], 'official-static')
        self.assertEqual(transport.command_index, 0)
        self.assertFalse(result['eraseStarted'])
        self.assertFalse(transport.is_open)

    def test_native_timeout_failure_is_visible_before_erase(self):
        from types import SimpleNamespace
        handle = SimpleNamespace(_port_handle=123, write_timeout=3)
        with patch('serial.win32.SetCommTimeouts', return_value=False), patch('serial.win32.GetLastError', return_value=5):
            with self.assertRaises(isp.IspError) as raised:
                isp.programming_timeouts(handle)
        self.assertEqual(raised.exception.code, 'TIMEOUT_CONFIG_FAILED')
        self.assertFalse(hasattr(handle, '_timeout'))

    def test_flash_uses_captured_128_byte_blocks_and_all_acknowledgements(self):
        # Synthetic firmware and UID. Frame shapes/block size derive from the
        # official transaction; this never opens a physical serial port.
        transport = CaptureTransport()
        transport._port_handle = 123  # native API is mocked below; never a real handle
        image = bytes(range(256)) * 2
        transport.exchanges.append((packet(0x6a, bytes.fromhex('03 00 00 5a a5')),
                                    packet(0x68, bytes.fromhex('03 00 11 22 33 44 55 66'))))
        size = CAPTURE['programBlockBytes']
        for offset in range(0, len(image), size):
            command = bytes([0x22 if offset == 0 else 0x02]) + offset.to_bytes(2, 'big') + bytes.fromhex('5a a5') + image[offset:offset+size]
            transport.exchanges.append((packet(0x6a, command), packet(0x68, b'\x02\x54')))
        transport.exchanges.append((packet(0x6a, bytes.fromhex('07 00 00 5a a5')), packet(0x68, b'\x07\x54')))
        transport.exchanges.append((None, packet(0x68, b'\x04\x54')))
        request = {'action': 'flash', 'port': 'COM9', 'protocol': 'stc15',
                   'mcu': 'IAP15F2K61S2', 'freqHz': 12_000_000, 'waitSeconds': 1}
        with patch('serial.Serial', return_value=transport), patch('serial.win32.SetCommTimeouts', return_value=True), patch.object(isp, 'load_image', return_value=image), patch.object(isp.time, 'sleep', return_value=None), contextlib.redirect_stdout(io.StringIO()):
            result = isp.run_session(request, emit=lambda event: None)
        self.assertTrue(result['ok'], result)
        self.assertTrue(result['programmed'])
        self.assertEqual(transport.command_index, len(transport.exchanges))
        self.assertEqual(transport.config_after_prepare, [], 'Programming timeout changes must not reconfigure the established UART')

    def test_real_session_replays_official_calibration_and_baud_switch(self):
        transport = CaptureTransport()
        request = {'action': 'handshake', 'port': 'COM9', 'protocol': 'stc15',
                   'mcu': 'IAP15F2K61S2', 'freqHz': 12_000_000, 'waitSeconds': 1}
        with patch('serial.Serial', return_value=transport), patch.object(isp.time, 'sleep', return_value=None), contextlib.redirect_stdout(io.StringIO()):
            result = isp.run_session(request, emit=lambda event: None)
        self.assertTrue(result['ok'], result)
        self.assertEqual(transport.command_index, 4)
        self.assertEqual(transport.pulses, [b'\x92', b'\x92'])
        self.assertEqual(transport.baudrate, 115200)
        self.assertFalse(result['eraseStarted'])
        self.assertFalse(result['programmed'])
        self.assertFalse(transport.is_open)
        self.assertEqual(result['calibration']['actualFreqHz'], 11_992_800)

    def test_invalid_calibration_response_aborts_flash_before_erase(self):
        transport = CaptureTransport()
        command, response = transport.exchanges[0]
        damaged = bytearray(response)
        damaged[6] = 12  # valid checksum, wrong number of measured candidates
        damaged[-3:-1] = (sum(damaged[2:-3]) & 0xffff).to_bytes(2, 'big')
        transport.exchanges[0] = command, bytes(damaged)
        request = {'action': 'flash', 'port': 'COM9', 'protocol': 'stc15',
                   'mcu': 'IAP15F2K61S2', 'freqHz': 12_000_000, 'waitSeconds': 1}
        with patch('serial.Serial', return_value=transport), patch.object(isp, 'load_image', return_value=b'x'), patch.object(isp.time, 'sleep', return_value=None), contextlib.redirect_stdout(io.StringIO()):
            result = isp.run_session(request, emit=lambda event: None)
        self.assertFalse(result['ok'])
        self.assertEqual(result['stage'], 'handshake')
        self.assertIn('invalid STC15 calibration response', result['message'])
        self.assertFalse(result['eraseStarted'])
        self.assertEqual(transport.command_index, 1)
        self.assertFalse(transport.is_open)

    def test_unmeasurable_frequency_is_rejected_before_erase(self):
        transport = CaptureTransport()
        request = {'action': 'flash', 'port': 'COM9', 'protocol': 'stc15',
                   'mcu': 'IAP15F2K61S2', 'freqHz': 40_000_000, 'waitSeconds': 1}
        with patch('serial.Serial', return_value=transport), patch.object(isp, 'load_image', return_value=b'x'), patch.object(isp.time, 'sleep', return_value=None), contextlib.redirect_stdout(io.StringIO()):
            result = isp.run_session(request, emit=lambda event: None)
        self.assertFalse(result['ok'])
        self.assertFalse(result['eraseStarted'])
        self.assertIn('outside measured', result['message'])
        self.assertEqual(transport.command_index, 1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
