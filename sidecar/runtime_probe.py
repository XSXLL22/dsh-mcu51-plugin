"""Read-only dependency and own-process integrity probe. Never opens a COM port."""
import json
import sys


def windows_integrity():
    import ctypes as c
    from ctypes import wintypes as w

    class SidAndAttributes(c.Structure):
        _fields_ = [('sid', w.LPVOID), ('attributes', w.DWORD)]

    kernel = c.WinDLL('kernel32', use_last_error=True)
    security = c.WinDLL('advapi32', use_last_error=True)
    kernel.GetCurrentProcess.argtypes = []
    kernel.GetCurrentProcess.restype = w.HANDLE
    kernel.CloseHandle.argtypes = [w.HANDLE]
    kernel.CloseHandle.restype = w.BOOL
    security.OpenProcessToken.argtypes = [w.HANDLE, w.DWORD, c.POINTER(w.HANDLE)]
    security.OpenProcessToken.restype = w.BOOL
    security.GetTokenInformation.argtypes = [w.HANDLE, c.c_int, w.LPVOID, w.DWORD, c.POINTER(w.DWORD)]
    security.GetTokenInformation.restype = w.BOOL
    security.IsValidSid.argtypes = [w.LPVOID]
    security.IsValidSid.restype = w.BOOL
    security.GetSidSubAuthorityCount.argtypes = [w.LPVOID]
    security.GetSidSubAuthorityCount.restype = c.POINTER(c.c_ubyte)
    security.GetSidSubAuthority.argtypes = [w.LPVOID, w.DWORD]
    security.GetSidSubAuthority.restype = c.POINTER(w.DWORD)

    token = w.HANDLE()
    if not security.OpenProcessToken(kernel.GetCurrentProcess(), 0x0008, c.byref(token)):
        raise c.WinError(c.get_last_error())
    try:
        size = w.DWORD()
        # TOKEN_INFORMATION_CLASS.TokenIntegrityLevel = 25; first ask for size.
        c.set_last_error(0)
        ok = security.GetTokenInformation(token, 25, None, 0, c.byref(size))
        if ok or c.get_last_error() != 122 or size.value < c.sizeof(SidAndAttributes):
            raise OSError('TokenIntegrityLevel size query failed: ' + str(c.get_last_error()))
        buf = c.create_string_buffer(size.value)
        if not security.GetTokenInformation(token, 25, buf, size.value, c.byref(size)):
            raise c.WinError(c.get_last_error())
        sid = c.cast(buf, c.POINTER(SidAndAttributes)).contents.sid
        if not security.IsValidSid(sid):
            raise OSError('TokenIntegrityLevel returned an invalid SID')
        count = security.GetSidSubAuthorityCount(sid)
        if not count or count[0] < 1:
            raise OSError('Integrity SID has no subauthority')
        authority = security.GetSidSubAuthority(sid, count[0] - 1)
        if not authority:
            raise OSError('Cannot read integrity RID')
        return int(authority[0])
    finally:
        if not kernel.CloseHandle(token):
            raise c.WinError(c.get_last_error())


def integrity_info():
    if sys.platform != 'win32':
        return {'ok': True, 'supported': False, 'platform': sys.platform}
    try:
        rid = windows_integrity()
        levels = [(4096, 'untrusted'), (8192, 'low'), (8448, 'medium'),
                  (12288, 'medium-plus'), (16384, 'high'), (20480, 'system')]
        level = next((name for upper, name in levels if rid < upper), 'protected-or-higher')
        return {'ok': True, 'supported': True, 'platform': sys.platform, 'rid': rid, 'level': level,
                'source': 'GetTokenInformation(TokenIntegrityLevel)', 'scope': 'current-bundled-python-process'}
    except Exception as error:
        return {'ok': False, 'supported': True, 'platform': sys.platform,
                'error': 'TOKEN_INTEGRITY_QUERY_FAILED', 'message': str(error)}


def main():
    import serial
    import stcgal
    import PIL
    import tqdm
    print(json.dumps({'version': sys.version.split()[0], 'serial': serial.__version__,
                      'stcgal': stcgal.__version__, 'PIL': PIL.__version__,
                      'isolated': sys.flags.isolated, 'paths': sys.path, 'integrity': integrity_info()}))


if __name__ == '__main__':
    main()
