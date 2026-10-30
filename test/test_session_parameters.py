"""Parameter and encoding guards; fake workers/drivers only, never COM access."""
import importlib.util
import json
import sys
import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'sidecar' / filename)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module

params = load('session_parameters', 'session_parameters.py')
serial_io = load('serial_params_io', 'serial_io.py')
isp = load('isp_params', 'isp.py')


class ParameterTests(unittest.TestCase):
    def test_bad_isp_parameters_never_construct_the_protocol(self):
        for change in [{'waitSeconds': True}, {'waitSeconds': '60'}, {'freqHz': '12000000'},
                       {'debug': 'false'}, {'baud': 9600}, {'handshakeBaud': 4800}, {'port': 'COM9\n'}]:
            result = isp.run_session({'action': 'chipinfo', 'protocol': 'auto', 'port': 'COM9', **change},
                                     factory=lambda opts: self.fail('protocol called'), emit=lambda event: None)
            self.assertFalse(result['ok'])
            self.assertFalse(result['hardwareAccess'])

    def test_bad_serial_payload_is_rejected_before_the_lease_or_worker(self):
        for change in [{'send': ['中'], 'encoding': 'ascii'}, {'untilRegex': '['}, {'seconds': True},
                       {'dataBits': 8, 'stopBits': 1.5}, {'noReset': True, 'rtscts': True}]:
            result = serial_io.run_locked_capture(dict(port='COM9', **change),
                                                  lease_factory=lambda *_a: self.fail('lease acquired'), worker=lambda *_a, **_k: self.fail('worker called'))
            self.assertFalse(result['ok'])
            self.assertFalse(result['hardwareAccess'])

    def test_frozen_bytes_and_budget_are_verified_again_before_the_lease(self):
        plan = params.make_serial_plan({'port': 'COM9', 'encoding': 'gbk', 'send': ['中']})
        self.assertEqual(plan['spec']['send'][0]['hex'], 'd6d00d0a')
        plan['spec']['send'][0]['hex'] = 'aa'
        result = serial_io.run_locked_capture({'sessionPlan': plan, 'expectedSessionPlanId': plan['sessionPlanId']},
                                              lease_factory=lambda *_a: self.fail('lease acquired'))
        self.assertFalse(result['ok'])
        self.assertFalse(result['hardwareAccess'])

    def test_dry_run_does_not_take_a_port_lease(self):
        result = serial_io.run_locked_capture({'port': 'COM9', 'dryRun': True, 'dataBits': 7, 'parity': 'E', 'stopBits': 2},
                                              lease_factory=lambda *_a: self.fail('lease acquired'))
        self.assertTrue(result['ok'])
        self.assertTrue(result['dryRun'])
        self.assertFalse(result['hardwareAccess'])

    def test_driver_receives_frame_and_flow_settings_with_control_lines_set_before_open(self):
        import serial
        calls = []
        class Handle:
            def __init__(self, **kwargs): self.kwargs = kwargs; calls.append(('init', kwargs['port']))
            def __setattr__(self, key, value):
                object.__setattr__(self, key, value)
                if key in ('dtr', 'rts'): calls.append((key, value))
            def open(self): calls.append(('open', self.port))
            def close(self): calls.append(('close', None))
        plan = params.make_serial_plan({'port': 'COM9', 'dataBits': 7, 'parity': 'E', 'stopBits': 2})
        with patch.object(serial, 'Serial', Handle):
            handle, error = serial_io.open_port(plan['spec'], 9600)
        self.assertIsNone(error)
        self.assertEqual(handle.kwargs['bytesize'], 7)
        self.assertEqual(handle.kwargs['parity'], 'E')
        self.assertEqual(handle.kwargs['stopbits'], 2)
        self.assertEqual(calls[:4], [('init', None), ('dtr', False), ('rts', False), ('open', 'COM9')])
        calls.clear()
        flow = params.make_serial_plan({'port': 'COM9', 'rtscts': True, 'noReset': False})
        with patch.object(serial, 'Serial', Handle):
            handle, error = serial_io.open_port(flow['spec'], 9600)
        self.assertIsNone(error)
        self.assertTrue(handle.kwargs['rtscts'])
        self.assertNotIn(('rts', False), calls)

    def test_control_line_failure_is_visible_and_never_opens_the_port(self):
        import serial
        calls = []
        class Handle:
            def __init__(self, **kwargs): pass
            def __setattr__(self, name, value): raise RuntimeError('control line request failed')
            def open(self): raise AssertionError('port must not open')
            def close(self): calls.append('close')
        with patch.object(serial, 'Serial', Handle):
            handle, error = serial_io.open_port(params.make_serial_plan({'port': 'COM9'})['spec'], 9600)
        self.assertIsNone(handle)
        self.assertIn('control line request failed', str(error))
        self.assertEqual(calls, ['close'])

    def test_receive_limit_bounds_binary_without_line_parsing(self):
        class Handle:
            def read(self, size): return b'\n' * size
        got = serial_io.collect(Handle(), params.make_serial_plan({'port': 'COM9', 'dataMode': 'binary', 'maxBytes': 20})['spec'])
        self.assertEqual(got['total'], 20)
        self.assertEqual(got['lines'], [])
        self.assertEqual(got['stopReason'], 'maxBytes')

    def test_frozen_plan_executes_exactly_the_prepared_bytes_under_its_lease(self):
        parent = ROOT / 'test/.tmp'
        parent.mkdir(exist_ok=True)
        temporary = tempfile.TemporaryDirectory(prefix='frozen session ', dir=parent)
        writes = []
        closed = []
        class Handle:
            def write(self, payload): writes.append(payload); return len(payload)
            def flush(self): pass
            def close(self): closed.append(True)
        data = {'raw': b'OK\n', 'lines': [{'t': 0, 'text': 'OK'}], 'total': 3, 'tail': b'', 'matched': None, 'error': None}
        plan = params.make_serial_plan({'port': 'COM9', 'encoding': 'gbk', 'send': [{'text': '中', 'delayMs': 500}], 'sendHex': ['aa55']})
        try:
            with patch.object(serial_io, 'open_port', return_value=(Handle(), None)), patch.object(serial_io, 'collect', return_value=data), \
                    patch.object(serial_io.time, 'sleep') as sleep:
                result = serial_io.run_locked_capture({'sessionPlan': plan, 'expectedSessionPlanId': plan['sessionPlanId']},
                                                      lease_factory=lambda port, kind: serial_io.port_sessions().PortLease(port, kind, root=temporary.name))
            self.assertTrue(result['ok'], result.get('message'))
            self.assertEqual(result['sessionPlanId'], plan['sessionPlanId'])
            self.assertEqual(writes, [b'\xd6\xd0\r\n', b'\xaa\x55'])
            self.assertEqual(result['sent'][0]['text'], '中')
            self.assertEqual(len(closed), 1)
            sleep.assert_called_once_with(0.5)
        finally:
            self.assertTrue(Path(temporary.name).resolve().is_relative_to(parent.resolve()))
            temporary.cleanup()

    def test_maximum_batch_stays_within_the_parent_stdout_budget(self):
        import io
        payload = (b'\x00' * 5 + b'\n') * 9999
        payload += b'\x00' * (65536 - len(payload) - 1) + b'\n'
        incoming = io.BytesIO(payload)
        class Handle:
            def read(self, size): return incoming.read(size)
            def write(self, data): return len(data)
            def flush(self): pass
            def close(self): pass
        plan = params.make_serial_plan({'port': 'COM9', 'baud': 4000000, 'seconds': 600,
                                        'maxLines': 10000, 'send': ['\x00' * 510] * 128})
        events = []
        with patch.object(serial_io, 'open_port', return_value=(Handle(), None)):
            result = serial_io.run_capture(plan['spec'], emit=events.append)
        result['sessionPlanId'] = plan['sessionPlanId']
        events.append(result)
        size = len(('\n'.join(json.dumps(event, ensure_ascii=False) for event in events) + '\n').encode('utf-8'))
        self.assertEqual(result['bytes'], 65536)
        self.assertEqual(result['lineCount'], 10000)
        self.assertLess(size, 2 * 1024 * 1024 - 4096)
        print('Maximum synthetic serial NDJSON bytes:', size)


if __name__ == '__main__':
    unittest.main(verbosity=2)
