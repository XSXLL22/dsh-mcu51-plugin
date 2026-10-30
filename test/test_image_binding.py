"""Image byte-binding guards before protocol factory. Simulated, no COM access."""
import hashlib
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_isp import isp, FakeProtocol

IMAGE = b'\x11\x22'


def request():
    return {'action': 'flash', 'protocol': 'stc15', 'port': 'COM9', 'mcu': 'IAP15F2K61S2', 'freqHz': 12000000,
            'expectedSha256': 'a' * 64,
            'imageBinding': {'schemaVersion': 1, 'imageId': 'b' * 64, 'buffer': 'code',
                             'hexSha256': 'a' * 64, 'denseSha256': hashlib.sha256(IMAGE).hexdigest(), 'denseBytes': 2}}


class BindingTests(unittest.TestCase):
    def test_malformed_and_mismatched_bindings_never_construct_a_protocol(self):
        for name, value in [('denseSha256', '0' * 64), ('denseBytes', 3), ('denseBytes', True),
                            ('hexSha256', '0' * 64), ('buffer', 'eeprom'), ('imageId', None)]:
            with self.subTest(name=name, value=value):
                spec = request()
                spec['imageBinding'][name] = value
                with patch.object(isp, 'load_image', return_value=IMAGE):
                    result = isp.run_session(spec, factory=lambda opts: self.fail('must reject before factory'), emit=lambda e: None)
                self.assertFalse(result['ok'])
                self.assertEqual(result['stage'], 'preflight')
                self.assertFalse(result['eraseStarted'])
                self.assertFalse(result['boundImageVerified'])

    def test_non_flash_binding_is_rejected(self):
        spec = request()
        spec['action'] = 'chipinfo'
        result = isp.run_session(spec, factory=lambda opts: self.fail('no factory'), emit=lambda e: None)
        self.assertFalse(result['ok'])
        self.assertEqual(result['error'], 'INVALID_IMAGE_BINDING')

    def test_success_keeps_bound_byte_receipt_and_original_programming_sequence(self):
        protocol = FakeProtocol()
        spec = request()
        with patch.object(isp, 'load_image', return_value=IMAGE):
            result = isp.run_session(spec, factory=lambda opts: SimpleNamespace(protocol=protocol), emit=lambda e: None)
        self.assertTrue(result['ok'], result.get('message'))
        self.assertTrue(result['boundImageVerified'])
        self.assertEqual(result['imageBinding'], spec['imageBinding'])
        self.assertEqual(protocol.calls, ['connect', 'initialize', 'handshake', 'erase', 'program', 'options', 'disconnect'])


if __name__ == '__main__':
    unittest.main()
