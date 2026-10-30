"""Closed transports only: framing must not depend on read chunk boundaries."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('serial_io', Path(__file__).resolve().parents[1] / 'sidecar/serial_io.py')
serial_io = importlib.util.module_from_spec(spec)
spec.loader.exec_module(serial_io)


class Chunks:
    def __init__(self, chunks):
        self.chunks = list(chunks)

    def read(self, size):
        if not self.chunks:
            raise OSError('injected end-of-stream')
        chunk = self.chunks.pop(0)
        if isinstance(chunk, Exception):
            raise chunk
        if len(chunk) > size:
            self.chunks.insert(0, chunk[size:])
        return chunk[:size]


def capture(chunks, **overrides):
    chunks = list(chunks)
    raw = b''.join(chunk for chunk in chunks if isinstance(chunk, bytes))
    spec = dict(serial_io.DEFAULT_SPEC, maxBytes=max(1, len(raw)), seconds=30)
    spec.update(overrides)
    return serial_io.collect(Chunks(chunks), spec)


class SerialLineTests(unittest.TestCase):
    def test_every_single_cut_and_bytewise_preserve_crlf_and_real_blank_lines(self):
        wire = b'HEAD\r\n\r\nDATA\rONLY\n\rTAIL\r\npartial'
        chunkings = [[wire[:cut], wire[cut:]] for cut in range(1, len(wire))]
        chunkings += [[bytes([byte]) for byte in wire], [wire]]
        for chunks in chunkings:
            with self.subTest(chunks=chunks):
                got = capture(chunks)
                self.assertEqual([line['text'] for line in got['lines']], ['HEAD', '', 'DATA', 'ONLY', '', 'TAIL'])
                self.assertEqual(got['tail'], b'partial')
                self.assertEqual(got['raw'], wire)
                self.assertEqual(got['total'], len(wire))
                self.assertIsNone(got['error'])

    def test_empty_reads_do_not_forget_cr(self):
        got = capture([b'A\r', b'', b'\nB\r', b'', b'\n'])
        self.assertEqual([line['text'] for line in got['lines']], ['A', 'B'])

    def test_lone_cr_completes_a_line_without_waiting_for_more_bytes(self):
        got = capture([b'DONE\r', OSError('must not read again')], until=['DONE'])
        self.assertEqual(got['matched'], 'DONE')
        self.assertEqual(got['stopReason'], 'until')
        self.assertIsNone(got['error'])
        self.assertEqual(got['tail'], b'')

    def test_max_lines_keeps_unreported_complete_lines_in_residual(self):
        got = capture([b'A\r\nB\npartial'], maxLines=1)
        self.assertEqual([line['text'] for line in got['lines']], ['A'])
        self.assertEqual(got['tail'], b'B\npartial')
        self.assertEqual(got['raw'], b'A\r\nB\npartial')
        self.assertEqual(got['stopReason'], 'maxLines')

    def test_regex_until_keeps_remaining_bytes_and_split_lf_is_not_a_line(self):
        got = capture([b'A\r', b'\nDONE\r\nB\n'], untilRegex='^DONE$')
        self.assertEqual([line['text'] for line in got['lines']], ['A', 'DONE'])
        self.assertEqual(got['tail'], b'B\n')
        self.assertEqual(got['matched'], 'DONE')

    def test_byte_budget_does_not_invent_a_line_for_partial_text(self):
        got = capture([b'A\r\nB\r\n'], maxBytes=4)
        self.assertEqual(got['raw'], b'A\r\nB')
        self.assertEqual(got['tail'], b'B')
        self.assertEqual(got['stopReason'], 'maxBytes')

    def test_read_failure_keeps_completed_cr_line_and_partial_bytes(self):
        got = capture([b'A\r', b'\npart', OSError('injected disconnect')], maxBytes=100)
        self.assertEqual([line['text'] for line in got['lines']], ['A'])
        self.assertEqual(got['raw'], b'A\r\npart')
        self.assertEqual(got['tail'], b'part')
        self.assertEqual(got['stopReason'], 'read-error')
        self.assertIn('injected disconnect', got['error'])

    def test_duration_expiry_does_not_flush_unterminated_text_as_a_line(self):
        ticks = iter([0, 0, 0, 2, 2])
        with patch.object(serial_io.time, 'monotonic', side_effect=lambda: next(ticks)):
            got = capture([b'A\rpart'], seconds=1, maxBytes=100)
        self.assertEqual([line['text'] for line in got['lines']], ['A'])
        self.assertEqual(got['tail'], b'part')
        self.assertEqual(got['stopReason'], 'duration')


if __name__ == '__main__':
    unittest.main(verbosity=2)
