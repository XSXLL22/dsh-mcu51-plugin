"""Offline differential oracle using the unchanged MIT stcgal getters/setters.

No transport/protocol object is created. The rstout setter takes a boolean even
though its getter returns high/low; this adapter makes that semantic explicit.
The upstream integer setters expect CLI strings, so numeric API inputs are
converted only at this oracle boundary, not in the product's strict codec.
The caller excludes the known-broken uart2_pin_mode setter and tests that
field against official binary-derived vectors instead.
"""
import json
import sys
from stcgal.options import Stc15Option

requests = json.loads(sys.stdin.buffer.read().decode('utf-8'))
results = []
for request in requests:
    decoder = Stc15Option(bytes.fromhex(request['raw']))
    before = {name: getter() for name, getter, _ in decoder.options}
    setters = {name: setter for name, _, setter in decoder.options}
    for name, value in request['patch'].items():
        if name == 'rstout_por_state':
            value = value == 'high'
        elif type(value) is int:
            value = str(value)
        setters[name](value)
    results.append({'before': before, 'afterRaw': decoder.get_msr().hex(' ')})
sys.stdout.buffer.write(json.dumps(results).encode('utf-8'))
