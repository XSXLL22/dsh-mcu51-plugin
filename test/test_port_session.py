"""Real OS locks/process lifecycle, simulated workers only; never opens a COM port."""
import importlib.util
import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / 'sidecar/port_session.py'
spec = importlib.util.spec_from_file_location('port_session', MODULE)
session = importlib.util.module_from_spec(spec)
spec.loader.exec_module(session)


class SessionTests(unittest.TestCase):
    def setUp(self):
        parent = ROOT / 'test/.tmp'
        parent.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='port session 中文 ', dir=parent)
        self.root = Path(self.temp.name)

    def tearDown(self):
        target = Path(self.temp.name).resolve()
        self.assertTrue(target.is_relative_to((ROOT / 'test/.tmp').resolve()))
        self.temp.cleanup()

    def test_lock_names_are_not_windows_reserved_device_names(self):
        # Constructor/string checks only: never open any legacy reserved path.
        for number in [*range(1, 10), 10, 999999]:
            lease = session.PortLease(f'cOm{number}', 'serial', root=self.root)
            self.assertEqual(lease.path.name, f'port-COM{number}.lock')
            self.assertIsNone(lease.handle)
            if sys.platform == 'win32':
                self.assertFalse(os.path.isreserved(lease.path.name))
        if sys.platform == 'win32':
            self.assertTrue(os.path.isreserved('COM9.lock'))
        self.assertEqual(list(self.root.iterdir()), [])

    def test_case_normalization_and_different_ports(self):
        with session.PortLease('com9', 'isp:chipinfo', root=self.root) as first:
            self.assertEqual(first.info()['port'], 'COM9')
            with self.assertRaises(session.SessionError) as busy:
                with session.PortLease('COM9', 'serial', root=self.root):
                    self.fail('same port acquired twice')
            self.assertEqual(busy.exception.code, 'PORT_BUSY')
            with session.PortLease('COM10', 'serial', root=self.root):
                pass
        # A leftover filename is normal; deleting it is not needed for recovery.
        self.assertTrue((self.root / 'port-COM9.lock').is_file())
        with session.PortLease('COM9', 'serial', root=self.root):
            pass

    def test_bad_ports_and_unavailable_lock_storage_fail_before_worker(self):
        for port in ['COM0', r'\\.\COM9', '../COM9', ' COM9', 9, None]:
            result = session.run_exclusive(port, 'serial', lambda: self.fail('worker called'), root=self.root)
            self.assertFalse(result['ok'])
            self.assertFalse(result['hardwareAccess'])
        blocked = self.root / 'file'
        blocked.write_text('not a directory', encoding='utf-8')
        result = session.run_exclusive('COM9', 'serial', lambda: self.fail('worker called'), root=blocked)
        self.assertEqual(result['error'], 'PORT_LOCK_UNAVAILABLE')

    def test_busy_never_calls_worker_and_failure_never_hides_uncertain_state(self):
        with session.PortLease('COM9', 'isp:flash', root=self.root):
            result = session.run_exclusive('COM9', 'serial', lambda: self.fail('worker called'), root=self.root)
            self.assertEqual(result['error'], 'PORT_BUSY')
            self.assertFalse(result['hardwareAccess'])
        def failed():
            raise RuntimeError('lost worker receipt')
        result = session.run_exclusive('COM9', 'isp:flash', failed, root=self.root)
        self.assertFalse(result['ok'])
        self.assertIsNone(result['eraseStarted'])
        self.assertEqual(result['operationState'], 'unknown-after-worker-error')
        self.assertTrue(result['session']['released'])
        with session.PortLease('COM9', 'serial', root=self.root):
            pass

    def test_cross_process_and_plugin_copy_conflict_then_kill_releases_os_lock(self):
        copy = self.root / 'other plugin copy.py'
        shutil.copyfile(MODULE, copy)
        code = '''import importlib.util,json,sys,time
s=importlib.util.spec_from_file_location('other',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
with m.PortLease('COM9','serial',root=sys.argv[2]) as lease:
 print(json.dumps(lease.info()),flush=True)
 time.sleep(30)
'''
        child = subprocess.Popen([sys.executable, '-I', '-B', '-c', code, str(copy), str(self.root)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
        try:
            ready = queue.Queue()
            threading.Thread(target=lambda: ready.put(child.stdout.readline()), daemon=True).start()
            info = json.loads(ready.get(timeout=5))
            self.assertEqual(info['port'], 'COM9')
            with self.assertRaises(session.SessionError):
                with session.PortLease('com9', 'isp:flash', root=self.root):
                    self.fail('cross-process lock bypassed')
        finally:
            child.kill()
            child.communicate(timeout=5)
        # OS release may lag process close briefly; this loop touches lock files only.
        deadline = time.monotonic() + 2
        while True:
            try:
                with session.PortLease('COM9', 'isp:chipinfo', root=self.root):
                    break
            except session.SessionError as error:
                if error.code != 'PORT_BUSY' or time.monotonic() >= deadline:
                    raise
                time.sleep(0.01)

    def test_worker_result_and_confirmed_writes_survive_unlock_errors(self):
        class BadRelease(session.PortLease):
            def close(self):
                super().close()
                raise session.SessionError('PORT_LOCK_RELEASE_FAILED', 'injected release failure')
        result = session.run_exclusive('COM9', 'isp:flash', lambda: {'ok': True, 'programmed': True},
                                       lease_factory=lambda port, kind: BadRelease(port, kind, root=self.root))
        self.assertFalse(result['ok'])
        self.assertTrue(result['programmed'])
        self.assertEqual(result['error'], 'PORT_LOCK_RELEASE_FAILED')
        self.assertTrue(result['cleanupErrors'])

    def load(self, name, filename):
        spec = importlib.util.spec_from_file_location(name, ROOT / 'sidecar' / filename)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_real_isp_and_serial_entry_wrappers_share_the_same_lease(self):
        isp = self.load('isp_guard', 'isp.py')
        serial = self.load('serial_guard', 'serial_io.py')
        factory = lambda port, kind: session.PortLease(port, kind, root=self.root)
        with session.PortLease('COM9', 'serial', root=self.root):
            for entry, request in [(isp.run_locked_session, {'port': 'com9', 'action': 'chipinfo'}), (serial.run_locked_capture, {'port': 'com9'})]:
                result = entry(request, worker=lambda *_a, **_k: self.fail('busy worker called'), lease_factory=factory)
                self.assertEqual(result['error'], 'PORT_BUSY')
                self.assertFalse(result['hardwareAccess'])
        events = []
        result = isp.run_locked_session({'port': 'COM9', 'action': 'chipinfo'}, emit=events.append,
                                        worker=lambda *_a, **_k: {'ok': True, 'programmed': False}, lease_factory=factory)
        self.assertTrue(result['session']['released'])
        self.assertEqual(events[0]['event'], 'session-acquired')
        wrong = isp.run_locked_session({'port': 'COM9', 'action': 'flash', 'mcu': 'IAP15F2K61S2', 'protocol': 'stc15', 'applicationId': 'expected'},
                                       emit=lambda event: None, worker=lambda *_a, **_k: {'ok': True, 'applicationId': 'wrong'}, lease_factory=factory)
        self.assertEqual(wrong['applicationId'], 'wrong')

    def test_serial_lease_covers_gaps_between_auto_baud_probes_and_final_close(self):
        serial = self.load('serial_probes', 'serial_io.py')
        calls = []
        def check_held():
            with self.assertRaises(session.SessionError):
                with session.PortLease('COM9', 'isp:flash', root=self.root):
                    self.fail('probe gap released port lease')
        class Handle:
            def close(self):
                check_held()
                calls.append('close')
        def opened(*_args):
            check_held()
            calls.append('open')
            return Handle(), None
        data = {'raw': b'OK\n', 'lines': [{'t': 0, 'text': 'OK'}], 'total': 3, 'tail': b'', 'matched': None, 'error': None}
        with patch.object(serial, 'open_port', side_effect=opened), patch.object(serial, 'collect', return_value=data):
            result = serial.run_locked_capture({'port': 'COM9', 'autoBaud': True, 'baudCandidates': [9600, 2400]},
                                               lease_factory=lambda port, kind: session.PortLease(port, kind, root=self.root))
        self.assertTrue(result['ok'])
        self.assertEqual(calls, ['open', 'close', 'open', 'close', 'open', 'close'])
        with session.PortLease('COM9', 'isp:chipinfo', root=self.root):
            pass


if __name__ == '__main__':
    unittest.main(verbosity=2)
