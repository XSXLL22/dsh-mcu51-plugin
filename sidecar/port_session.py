"""Cross-process, per-user COM leases held by the actual serial-owning process.

Never delete a lock file to unlock it. The OS owns the lock lifetime, not a PID.
"""
import errno
import os
import re
import sys
import uuid
from pathlib import Path


class SessionError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def normalize_port(port):
    if not isinstance(port, str) or not re.fullmatch(r'COM[1-9][0-9]{0,5}', port, re.IGNORECASE):
        raise SessionError('BAD_PORT', 'Expected COM followed by 1~6 decimal digits, with no path/whitespace')
    return port.upper()


def default_root():
    # Independent of install location, generation and configurable dataDir.
    return Path.home() / '.dsh-mcu51' / 'port-locks'


class PortLease:
    def __init__(self, port, kind, root=None):
        self.port = normalize_port(port)
        self.kind = kind
        # COM1..COM9 remain Windows device names even when followed by .lock.
        self.path = (Path(root) if root is not None else default_root()) / ('port-' + self.port + '.lock')
        self.handle = None
        self.acquired = False
        self.session_id = str(uuid.uuid4())

    def info(self):
        return {'sessionId': self.session_id, 'port': self.port, 'kind': self.kind, 'pid': os.getpid(),
                'scope': 'same-user/same-lock-directory', 'lockPath': str(self.path),
                'backend': 'msvcrt-byte-range' if sys.platform == 'win32' else 'fcntl-flock'}

    def __enter__(self):
        if self.handle is not None:
            raise SessionError('PORT_SESSION_ACTIVE', 'Lease is already active')
        locking = False
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.handle = self.path.open('a+b')
            os.set_inheritable(self.handle.fileno(), False)
            self.handle.seek(0)
            locking = True
            if sys.platform == 'win32':
                import msvcrt
                msvcrt.locking(self.handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.acquired = True
            return self
        except OSError as error:
            if self.handle is not None:
                self.handle.close()
                self.handle = None
            # A lock violation has EACCES/EAGAIN; file-open permission errors must
            # not masquerade as another active programmer.
            code = 'PORT_BUSY' if locking and error.errno in (errno.EACCES, errno.EAGAIN, errno.EDEADLK) else 'PORT_LOCK_UNAVAILABLE'
            raise SessionError(code, str(error)) from error

    def close(self):
        if self.handle is None:
            return
        try:
            if self.acquired:
                self.handle.seek(0)
                if sys.platform == 'win32':
                    import msvcrt
                    msvcrt.locking(self.handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(self.handle.fileno(), fcntl.LOCK_UN)
        except OSError as error:
            raise SessionError('PORT_LOCK_RELEASE_FAILED', str(error)) from error
        finally:
            self.handle.close()
            self.handle = None
            self.acquired = False

    def __exit__(self, *_exception):
        self.close()


def run_exclusive(port, kind, worker, root=None, lease_factory=None, on_acquired=None):
    lease = None
    try:
        lease = lease_factory(port, kind) if lease_factory else PortLease(port, kind, root=root)
        lease.__enter__()
    except Exception as error:
        return {'ok': False, 'error': getattr(error, 'code', 'PORT_LOCK_UNAVAILABLE'), 'message': str(error),
                'stage': 'preflight', 'hardwareAccess': False, 'programmed': False, 'eraseStarted': False,
                'programAcknowledged': False, 'hardwareOptionsWritten': False, 'session': None}
    info = lease.info()
    try:
        if on_acquired:
            on_acquired(info)
        result = worker()
        if not isinstance(result, dict) or not isinstance(result.get('ok'), bool):
            raise RuntimeError('Worker did not return a valid completion receipt')
    except Exception as error:
        result = {'ok': False, 'error': 'SESSION_WORKER_FAILED', 'message': str(error),
                  'hardwareAccess': None, 'operationState': 'unknown-after-worker-error', 'eraseStarted': None,
                  'programAcknowledged': None, 'hardwareOptionsWritten': None}
    finally:
        release_error = None
        try:
            lease.close()
        except Exception as error:
            release_error = str(error)
    if release_error:
        if result.get('ok'):
            result.update(error='PORT_LOCK_RELEASE_FAILED', message=release_error)
        result['ok'] = False
        result.setdefault('cleanupErrors', []).append('port lease: ' + release_error)
    result['session'] = {**info, 'released': release_error is None}
    return result
