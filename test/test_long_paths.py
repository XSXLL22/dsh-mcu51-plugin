"""Actual filesystem checks; no registry changes or serial access."""
import hashlib
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_isp import isp


class LongPathTests(unittest.TestCase):
    def test_long_unicode_hex_and_bound_source_keep_original_identity(self):
        module = isp.memory_applications()
        root = Path(tempfile.mkdtemp(prefix='mcu-long-'))
        try:
            raw_path = root / ('中文目录' * 12) / ('nested' * 24) / ('hex' * 20 + '.hex')
            self.assertGreater(len(str(raw_path)), 260)
            file = module.file_path(str(raw_path))
            file.parent.mkdir(parents=True)
            data = b':01000000AA55\n:00000001FF\n'
            file.write_bytes(data)
            record = {'path': str(raw_path), 'sha256': hashlib.sha256(data).hexdigest()}
            original = dict(record)
            module.file_check(record)
            self.assertEqual(record, original)
            self.assertEqual(isp.load_image({'hex': str(raw_path), 'expectedSha256': record['sha256']}), b'\xaa')
            with self.assertRaises(module.MemoryError) as caught:
                module.file_check({**record, 'sha256': '0' * 64})
            self.assertEqual(caught.exception.code, 'MEMORY_FILE_CHANGED')
        finally:
            self.assertEqual(root.parent.resolve(), Path(tempfile.gettempdir()).resolve())
            cleanup = '\\\\?\\' + str(root) if os.name == 'nt' else str(root)
            shutil.rmtree(cleanup)

    def test_relative_path_is_not_rewritten(self):
        self.assertEqual(isp.memory_applications().file_path('local.hex'), Path('local.hex'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
