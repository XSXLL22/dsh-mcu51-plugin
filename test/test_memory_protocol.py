"""Run real bundled methods against packet sinks; no serial object/port is opened."""
import contextlib
import io
import json
import unittest
from unittest.mock import patch

from stcgal.protocols import Stc15Protocol


class MemoryProtocolTests(unittest.TestCase):
    def setUp(self):
        self.no_serial = patch('serial.Serial', side_effect=AssertionError('physical serial factory must never run'))
        self.no_serial.start()
        self.addCleanup(self.no_serial.stop)

    def protocol(self):
        # Skip __init__ completely: no path, native handle or driver is constructed.
        protocol = object.__new__(Stc15Protocol)
        protocol.bsl_version = 0x72
        protocol.PROGRAM_BLOCKSIZE = 128
        protocol.uid = None
        protocol.progress_cb = lambda *_: None
        protocol.packets = []
        protocol.write_packet = protocol.packets.append
        protocol.read_packet = lambda: bytes.fromhex('03 00 11 22 33 44 55 66')
        return protocol

    def test_code_erase_payload_does_not_encode_image_or_code_length(self):
        with contextlib.redirect_stdout(io.StringIO()):
            packets = []
            for image_bytes, code_bytes in [(512, 62464), (4096, 62464), (62464, 62464), (512, 8192)]:
                protocol = self.protocol()
                protocol.erase_flash(image_bytes, code_bytes)
                self.assertEqual(protocol.packets, [bytes.fromhex('03 00 00 5a a5')])
                packets.append(protocol.packets[0].hex(' '))
        print(json.dumps({'simulation': True, 'hardwareAccess': False, 'differentLengthsSameErasePayload': packets}))

    def test_upstream_overflow_boolean_is_not_official_sector_count(self):
        with contextlib.redirect_stdout(io.StringIO()):
            protocol = self.protocol()
            protocol.erase_flash(8192 + 513, 8192)
        self.assertEqual(protocol.packets, [bytes.fromhex('03 01 00 5a a5')])
        # Official 409219..409223: ceil((8705-8192)/512) = 2, not 1.
        self.assertNotEqual(protocol.packets[0], bytes.fromhex('03 02 00 5a a5'))
        print(json.dumps({'simulation': True, 'hardwareAccess': False, 'bundledOverflowPayload': protocol.packets[0].hex(' '),
                          'officialStatic513DataBytesPayload': '03 02 00 5a a5'}))

    def test_linear_program_addresses_cross_code_boundary_and_use_first_next_finish_commands(self):
        protocol = self.protocol()
        protocol.read_packet = lambda: b'\x07\x54' if protocol.packets[-1][0] == 7 else b'\x02\x54'
        payload = b'\xff' * 8192 + b'\xaa\x55' + b'\xff' * 126
        with contextlib.redirect_stdout(io.StringIO()):
            protocol.program_flash(payload)
        blocks = protocol.packets[:-1]
        self.assertEqual(blocks[0][:5], bytes.fromhex('22 00 00 5a a5'))
        self.assertEqual(blocks[1][:5], bytes.fromhex('02 00 80 5a a5'))
        self.assertEqual(blocks[-1][:7], bytes.fromhex('02 20 00 5a a5 aa 55'))
        self.assertEqual(protocol.packets[-1], bytes.fromhex('07 00 00 5a a5'))
        self.assertEqual(len(blocks), 65)
        print(json.dumps({'simulation': True, 'hardwareAccess': False, 'blockBytes': 128,
                          'firstHeader': blocks[0][:5].hex(' '), 'dataAt8192Header': blocks[-1][:7].hex(' ')}))


if __name__ == '__main__':
    unittest.main(verbosity=2)
