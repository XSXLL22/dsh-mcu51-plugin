import json
import sys

sys.stdout.reconfigure(encoding="utf-8")
try:
    from serial.tools import list_ports
    items = [{"port": p.device, "description": p.description, "hwid": p.hwid, "vid": p.vid, "pid": p.pid} for p in list_ports.comports()]
    print(json.dumps({"ok": True, "items": items}, ensure_ascii=False))
except Exception as exc:
    print(json.dumps({"ok": False, "items": [], "message": str(exc)}, ensure_ascii=False))
    sys.exit(1)
