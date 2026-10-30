"""Offline cross-language intent check; never constructs a transport."""
import importlib.util
import json
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location('isp', Path(__file__).resolve().parents[1] / 'sidecar/isp.py')
isp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(isp)
intent = isp.validate_application_request(json.loads(sys.stdin.buffer.read().decode('utf-8')))
sys.stdout.buffer.write(json.dumps({'ok': intent is not None, 'hardwareAccess': False}).encode('utf-8'))
