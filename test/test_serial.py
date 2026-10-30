import importlib.util
import unittest
from unittest.mock import patch
from pathlib import Path

spec = importlib.util.spec_from_file_location("serial_io", Path(__file__).resolve().parents[1] / "sidecar" / "serial_io.py")
serial_io = importlib.util.module_from_spec(spec)
spec.loader.exec_module(serial_io)


class SerialPayloadTests(unittest.TestCase):
    def test_hex_payload_does_not_get_a_newline(self):
        self.assertEqual(serial_io.encode_payload({"hex": "AA 55 00 FF"}, "\r\n", "ascii"), b"\xaa\x55\x00\xff")

    def test_invalid_hex_is_reported(self):
        with self.assertRaises(ValueError):
            serial_io.encode_payload({"hex": "XYZ"}, "\r\n", "ascii")

    def test_text_encoding_never_silently_replaces_characters(self):
        with self.assertRaises(UnicodeEncodeError):
            serial_io.encode_payload({"text": "中"}, "\r\n", "ascii")

    def test_text_newline(self):
        self.assertEqual(serial_io.encode_payload({"text": "V"}, "\r\n", "ascii"), b"V\r\n")

    def test_initial_open_failure_is_not_automatically_retried(self):
        import serial
        with patch.object(serial, 'Serial', side_effect=serial.SerialException('simulated occupied port')) as factory, \
                patch.object(serial_io.time, 'sleep', side_effect=AssertionError('unexpected retry')):
            handle, error = serial_io.open_port({'port': 'SIMULATED', 'openRetrySeconds': 0}, 9600)
        self.assertIsNone(handle)
        self.assertIsNotNone(error)
        self.assertEqual(factory.call_count, 1)

    def test_partial_write_is_not_reported_as_a_complete_send(self):
        class Handle:
            closed = False
            def write(self, payload): return 1
            def flush(self): raise AssertionError('partial write must not be confirmed')
            def close(self): self.closed = True
        handle = Handle()
        data = {'raw': b'', 'lines': [], 'total': 0, 'tail': b'', 'matched': None, 'error': None}
        events = []
        with patch.object(serial_io, 'open_port', return_value=(handle, None)), patch.object(serial_io, 'collect', return_value=data):
            result = serial_io.run_capture(dict(serial_io.DEFAULT_SPEC, port='SIMULATED', send=[{'text': 'ABC'}]), emit=events.append)
        self.assertFalse(result['ok'])
        self.assertEqual(result['sent'], [])
        self.assertIn('Partial write', result['sendError'])
        self.assertEqual(result['transmitState'], 'partial-or-failed')
        self.assertTrue(result['sendMayHaveStarted'])
        self.assertTrue(handle.closed)
        self.assertFalse(any(event['event'] == 'serial-sent' for event in events))

    def test_capture_and_close_failures_are_both_exposed(self):
        class Handle:
            def close(self): raise RuntimeError('injected close error')
        with patch.object(serial_io, 'open_port', return_value=(Handle(), None)), \
                patch.object(serial_io, 'collect', side_effect=RuntimeError('injected capture error')):
            result = serial_io.run_capture(dict(serial_io.DEFAULT_SPEC, port='SIMULATED'))
        self.assertFalse(result['ok'])
        self.assertIn('injected capture error', result['message'])
        self.assertIn('injected close error', result['cleanupErrors'][0])

    def test_successful_send_emits_a_host_write_receipt_before_capture(self):
        calls = []
        class Handle:
            def write(self, payload): calls.append(payload); return len(payload)
            def flush(self): calls.append('flush')
            def close(self): calls.append('close')
        data = {'raw': b'OK\n', 'lines': [{'t': 0, 'text': 'OK'}], 'total': 3, 'tail': b'', 'matched': None, 'error': None}
        events = []
        with patch.object(serial_io, 'open_port', return_value=(Handle(), None)), patch.object(serial_io, 'collect', return_value=data):
            result = serial_io.run_capture(dict(serial_io.DEFAULT_SPEC, port='SIMULATED', send=[{'text': 'ABC'}]), emit=events.append)
        self.assertTrue(result['ok'])
        self.assertEqual(calls, [b'ABC\r\n', 'flush', 'close'])
        self.assertEqual([event['sent']['hex'] for event in events if event['event'] == 'serial-sent'], ['41 42 43 0d 0a'])


if __name__ == "__main__":
    unittest.main(verbosity=2)
