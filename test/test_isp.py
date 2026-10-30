"""ISP orchestration fault tests plus a real STC15 status-frame replay.

All transports are simulated; this suite never opens a physical COM port.
"""
import contextlib
import importlib.util
import io
import struct
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("isp", Path(__file__).resolve().parents[1] / "sidecar" / "isp.py")
isp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(isp)


class FakeProtocol:
    def __init__(self, fail=None, model="IAP15F2K61S2", capacity=62464):
        self.fail = fail
        self.calls = []
        self.model = SimpleNamespace(name=model, code=capacity)
        self.mcu_magic = 0xF449
        self.mcu_bsl_version = "7.2.5S"
        self.mcu_clock_hz = 12_000_000
        self.uid = None
        self.ser = SimpleNamespace(is_open=True, close=self.close)

    def call(self, name):
        self.calls.append(name)
        if self.fail == name:
            raise RuntimeError("injected " + name + " failure")

    def pulse(self, *args, **kwargs): pass
    def connect(self): self.call("connect")
    def initialize(self, base): self.call("initialize")
    def handshake(self): self.call("handshake")
    def erase_flash(self, length, capacity): self.call("erase")
    def program_flash(self, data): self.call("program")
    def program_options(self): self.call("options")
    def disconnect(self): self.call("disconnect"); self.ser.close()
    def close(self): self.ser.is_open = False


def run_fake(action="flash", fail=None, model="IAP15F2K61S2", image=b"x", capacity=62464):
    protocol = FakeProtocol(fail, model, capacity)
    opts_seen = []
    def factory(opts):
        opts_seen.append(opts)
        return SimpleNamespace(protocol=protocol)
    request = {"action": action, "port": "COM9", "protocol": "stc15", "mcu": "IAP15F2K61S2", "freqHz": 12_000_000}
    with patch.object(isp, "load_image", return_value=image):
        result = isp.run_session(request, factory=factory, emit=lambda event: None)
    return result, protocol, opts_seen


class SessionTests(unittest.TestCase):
    def test_factory_clock_handshake_uses_status_trim_and_checks_both_acks(self):
        writes = []
        protocol = SimpleNamespace(bsl_version=0x72, external_clock=False, baud_transfer=115200, freq_count_24=0x95, ser=SimpleNamespace(baudrate=2400))
        protocol.write_packet = writes.append
        replies = iter([b'\x01', b'\x05'])
        protocol.read_packet = lambda: next(replies)
        isp.factory_baud_handshake(protocol)
        self.assertEqual(writes, [bytes.fromhex('01 95 40 FF CC 00 00 C3'), bytes.fromhex('05 00 00 5A A5')])
        self.assertEqual(protocol.ser.baudrate, 115200)

    def test_factory_clock_handshake_rejects_missing_ack(self):
        protocol = SimpleNamespace(bsl_version=0x72, external_clock=False, baud_transfer=115200, freq_count_24=0x95, ser=SimpleNamespace(baudrate=2400), write_packet=lambda data: None, read_packet=lambda: b'\x00')
        with self.assertRaises(Exception):
            isp.factory_baud_handshake(protocol)
        self.assertEqual(protocol.ser.baudrate, 2400)

    def test_sync_reopens_a_port_that_disappeared_after_opening(self):
        import serial
        protocol = FakeProtocol()
        protocol.ser.write = lambda value: None
        protocol.ser.flush = lambda: None
        protocol.ser.in_waiting = 1
        attempts = []
        def connect():
            attempts.append(1)
            protocol.pulse()
            if len(attempts) == 1:
                raise serial.SerialException('USB port disappeared')
        protocol.connect = connect
        with patch.object(isp.time, 'sleep', return_value=None):
            isp.bounded_connect(protocol, 1)
        self.assertEqual(len(attempts), 2)
        self.assertIn('USB port disappeared', protocol.connection_diagnostics)

    def test_initial_busy_port_is_not_silently_retried(self):
        import serial
        protocol = FakeProtocol()
        attempts = []
        def connect():
            attempts.append(1)
            raise serial.SerialException('port busy')
        protocol.connect = connect
        with self.assertRaises(serial.SerialException):
            isp.bounded_connect(protocol, 1)
        self.assertEqual(len(attempts), 1)

    def test_chipinfo_never_calibrates_or_writes(self):
        result, protocol, _ = run_fake("chipinfo")
        self.assertTrue(result["ok"])
        self.assertFalse(result["programmed"])
        self.assertEqual(protocol.calls, ["connect", "initialize", "disconnect"])
        self.assertFalse(protocol.ser.is_open)

    def test_success_requires_all_programming_steps(self):
        result, protocol, opts = run_fake()
        self.assertTrue(result["ok"])
        self.assertTrue(result["programmed"])
        self.assertEqual(protocol.calls, ["connect", "initialize", "handshake", "erase", "program", "options", "disconnect"])
        self.assertEqual(opts[0].trim, 12000)
        self.assertFalse(result["verification"]["independentReadback"])
        self.assertEqual(result.get('timing'), [], 'Non-debug success must return an empty timing list')

    def test_failures_report_exact_stage_and_close_owned_port(self):
        for failure in ("handshake", "erase", "program", "options", "disconnect"):
            with self.subTest(stage=failure):
                result, protocol, _ = run_fake(fail=failure)
                self.assertFalse(result["ok"])
                self.assertFalse(result["programmed"])
                self.assertEqual(result["stage"], failure)
                self.assertFalse(protocol.ser.is_open)
                self.assertEqual(result["eraseStarted"], failure != "handshake")

    def test_wrong_mcu_aborts_before_erase(self):
        result, protocol, _ = run_fake(model="STC89C52RC")
        self.assertEqual(result["error"], "MCU_MISMATCH")
        self.assertNotIn("erase", protocol.calls)
        self.assertNotIn("handshake", protocol.calls)

    def test_capacity_overflow_is_rejected_without_truncation(self):
        result, protocol, _ = run_fake(image=b"x" * 513, capacity=512)
        self.assertEqual(result["error"], "FLASH_OVERFLOW")
        self.assertNotIn("erase", protocol.calls)

    def test_changed_hex_aborts_before_port_open(self):
        request = {"hex": str(Path(__file__).resolve()), "expectedSha256": "0" * 64}
        with self.assertRaises(isp.IspError) as raised:
            isp.load_image(request)
        self.assertEqual(raised.exception.code, "HEX_CHANGED")

    def test_sync_deadline(self):
        protocol = FakeProtocol()
        protocol.ser.write = lambda value: None
        protocol.ser.flush = lambda: None
        protocol.ser.in_waiting = 0
        protocol.connect = lambda: protocol.pulse()
        with self.assertRaises(isp.IspError) as raised:
            isp.bounded_connect(protocol, 0.01)
        self.assertEqual(raised.exception.code, "BOOTLOADER_TIMEOUT")

    def test_real_stc15_status_frame_725s_is_read_without_flash_commands(self):
        # Synthetic transport fixture, NOT captured hardware evidence. It drives
        # the unmodified stcgal checksum parser, status decoder and disconnect.
        status = bytearray(38)
        status[0] = 0x50
        status[1:3] = struct.pack(">H", 34771)
        status[7] = 1  # internal oscillator
        status[8:12] = struct.pack(">I", 12_000_000)
        status[17:19] = bytes([0x72, ord("S")])
        status[20:22] = bytes([0xF4, 0x49])
        status[22] = 5
        header = b"\x68" + struct.pack(">H", len(status) + 6) + status
        frame = b"\x46\xb9" + header + struct.pack(">H", sum(header) & 0xffff) + b"\x16"

        class Transport:
            def __init__(self):
                self.is_open = True
                self.buffer = b""
                self.writes = []
                self.status_read_complete = False
                self.config_after_status = []
                self._timeout = None
                self._inter_byte_timeout = None
            @property
            def timeout(self): return self._timeout
            @timeout.setter
            def timeout(self, value):
                if self.status_read_complete: self.config_after_status.append(('timeout', value))
                self._timeout = value
            @property
            def interCharTimeout(self): return self._inter_byte_timeout
            @interCharTimeout.setter
            def interCharTimeout(self, value):
                if self.status_read_complete: self.config_after_status.append(('interCharTimeout', value))
                self._inter_byte_timeout = value
            @property
            def in_waiting(self): return len(self.buffer)
            def flushInput(self): self.buffer = b""
            def flush(self): pass
            def write(self, data):
                self.writes.append(data)
                if data == b"\x7f": self.buffer += frame
            def read(self, count):
                data, self.buffer = self.buffer[:count], self.buffer[count:]
                if data and not self.buffer: self.status_read_complete = True
                return data
            def close(self): self.is_open = False

        transport = Transport()
        request = {"action": "chipinfo", "port": "COM9", "protocol": "stc15", "mcu": "IAP15F2K61S2", "waitSeconds": 1}
        with patch("serial.Serial", return_value=transport), contextlib.redirect_stdout(io.StringIO()):
            result = isp.run_session(request, emit=lambda event: None)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["chip"]["bslVersion"], "7.2.5S")
        self.assertEqual(result["chip"]["freqHz"], 12_000_000)
        commands = [data[5] for data in transport.writes if data.startswith(b"\x46\xb9")]
        self.assertEqual(commands, [0x82])
        # After a valid status frame Windows SetCommState must not be invoked
        # merely to change read timeouts before the next BSL command.
        self.assertEqual(transport.config_after_status, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
