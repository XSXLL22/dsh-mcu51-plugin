"""Product integration over closed transports/clock/Win32. Never opens COM."""
import contextlib
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
from test_options_apply import isp, transport, request, replay
from test_stc15_capture import packet
from serial import win32
from stcgal.protocols import Stc15Protocol

receiver = isp.erase_receivers()
UID = '00112233445566'
ACK = packet(0x68, b'\x03'+bytes.fromhex(UID))


class Clock:
    def __init__(self, advancing=True): self.value=0.0; self.advancing=advancing
    def __call__(self): return self.value
    def sleep(self, value):
        if self.advancing: self.value+=value


@contextlib.contextmanager
def native_mode(handle, evidence):
    evidence['nativeTimeouts'].update(snapshotTaken=True, setAttempted=True, nonblockingSet=True)
    try: yield
    finally: evidence['nativeTimeouts']['restored']=True


def run(initial=ACK, *, late=b'', delay=0, uid=UID, clock=None, timeout_mode=native_mode, change_status=None, broken_read=None):
    handle=transport(); command,_=handle.exchanges[4]; handle.exchanges[4]=command,initial
    if change_status:
        status=bytearray(handle.status); change_status(status)
        status[-3:-1]=(sum(status[2:-3])&0xffff).to_bytes(2,'big'); handle.status=bytes(status)
    original_read=handle.read; tail=bytearray(late); clock=clock or Clock(); seen=[]
    def read(size):
        if handle.command_index==5:
            if broken_read: return broken_read(size,clock)
            if not handle.buffer and clock()>=delay:
                value=bytes(tail[:size]); del tail[:size]; return value
        return original_read(size)
    handle.read=read
    prepare=receiver.prepare; original_erase=Stc15Protocol.erase_flash
    def prepared(protocol, expected):
        seen.append(protocol)
        return prepare(protocol, expected, clock=clock, sleep=clock.sleep, timeout_mode=timeout_mode)
    spec=request()
    if uid is not None: spec['expectedUid']=uid
    with patch.object(receiver,'prepare',side_effect=prepared): result=replay(spec,handle)
    assert not handle.is_open and handle.config_after_prepare==[]
    assert Stc15Protocol.erase_flash is original_erase
    for protocol in seen: assert 'read_packet' not in protocol.__dict__
    return result,handle,clock


class ProductReceiverTests(unittest.TestCase):
    def stopped(self,result,handle,code):
        self.assertFalse(result['ok'],result)
        self.assertEqual(result['stage'],'erase')
        self.assertEqual(result['error'],code)
        self.assertTrue(result['eraseStarted'])
        self.assertFalse(result['programAcknowledged'])
        self.assertFalse(result['hardwareOptionsWriteStarted'])
        self.assertEqual(handle.command_index,5)
        if result['eraseReception'] is not None: self.assertIn('不自动重试',result['nextAction'])

    def test_complete_session_returns_bound_identity_and_restores_instance_only(self):
        result,handle,_=run()
        self.assertTrue(result['ok'],result)
        self.assertEqual(handle.command_index,len(handle.exchanges))
        evidence=result['eraseReception']
        self.assertTrue(evidence['originalEraseReturned'])
        self.assertEqual(evidence['actualUid'],UID)
        self.assertTrue(evidence['frameAndUidMatched'])
        self.assertFalse(evidence['beforeEraseIdentityVerified'])

    def test_zero_then_delayed_reply_requires_complete_valid_uid(self):
        result,_,_=run(b'\0',late=ACK,delay=2.6)
        self.assertTrue(result['ok'],result)
        self.assertEqual(result['eraseReception']['rxHex'],(b'\0'+ACK).hex())
        self.assertGreaterEqual(result['eraseReception']['elapsedMs'],2600)

    def test_wrong_uid_stops_after_erase_and_exposes_actual_identity(self):
        result,handle,_=run(packet(0x68,b'\x03'+b'\xff'*7)+ACK)
        self.stopped(result,handle,'ERASE_RX_UID_MISMATCH')
        self.assertEqual(result['eraseReception']['actualUid'],'FF'*7)
        self.assertFalse(result['eraseReception']['frameAndUidMatched'])

    def test_wrong_command_or_uid_length_is_not_skipped(self):
        for payload in (b'',b'\x04'+bytes.fromhex(UID),b'\x03',b'\x03'+bytes.fromhex(UID)+b'\0'):
            result,handle,_=run(packet(0x68,payload)+ACK)
            self.stopped(result,handle,'ERASE_RX_ACK_INVALID')

    def test_bad_checksums_and_tail_are_counted_before_later_good_frame(self):
        for index in (-1,-2,-3):
            bad=bytearray(ACK); bad[index]^=1
            result,_,_=run(bytes(bad)+ACK)
            self.assertTrue(result['ok'],result)
            self.assertEqual(result['eraseReception']['invalidFrames'],1)

    def test_zero_only_and_partial_reply_exhaust_time_without_programming(self):
        for raw in (b'\0',ACK[:-1]):
            result,handle,_=run(raw)
            self.stopped(result,handle,'ERASE_RX_TIMEOUT')
            self.assertEqual(result['eraseReception']['rxHex'],raw.hex())
            self.assertEqual(result['eraseReception']['elapsedMs'],10000)

    def test_time_is_checked_after_a_late_native_read(self):
        data=bytearray(ACK)
        def read(size,clock):
            chunk=bytes(data[:size]); del data[:size]
            if not data: clock.value=20
            return chunk
        result,handle,_=run(b'',broken_read=read)
        self.stopped(result,handle,'ERASE_RX_TIMEOUT')
        self.assertFalse(result['eraseReception']['frameAndUidMatched'])

    def test_byte_and_poll_budgets_even_when_clock_is_frozen(self):
        result,handle,_=run(b'',clock=Clock(False),broken_read=lambda n,c:b'\0'*n)
        self.stopped(result,handle,'ERASE_RX_BYTE_BUDGET')
        self.assertEqual(result['eraseReception']['readBytes'],4096)
        result,handle,_=run(b'',clock=Clock(False))
        self.stopped(result,handle,'ERASE_RX_POLL_BUDGET')
        self.assertEqual(result['eraseReception']['polls'],4096)

    def test_last_budget_byte_can_complete_an_ack_but_no_byte_beyond_it(self):
        result,_,_=run(b'\0'*(4096-len(ACK))+ACK)
        self.assertTrue(result['ok'],result)
        result,handle,_=run(b'\0'*(4097-len(ACK))+ACK)
        self.stopped(result,handle,'ERASE_RX_BYTE_BUDGET')

    def test_overlap_bare_header_and_invalid_lengths(self):
        for raw in (b'\x46'+ACK,b'\x46\xb9'+ACK,ACK[2:],b'\x46\xb9\x68\0\x05'+ACK,b'\x46\xb9\x68\x01'+ACK):
            result,_,_=run(raw); self.assertTrue(result['ok'],result)

    def test_restore_failure_after_ack_blocks_programming(self):
        @contextlib.contextmanager
        def failed(handle,evidence):
            yield
            raise receiver.ReceiveError('ERASE_RX_TIMEOUT_RESTORE','injected')
        result,handle,_=run(timeout_mode=failed)
        self.stopped(result,handle,'ERASE_RX_TIMEOUT_RESTORE')
        self.assertTrue(result['eraseReception']['frameAndUidMatched'])
        self.assertFalse(result['eraseReception']['originalEraseReturned'])

    def test_disconnect_error_is_not_retried_or_replaced(self):
        def failed(*_): raise OSError('injected disconnection')
        result,handle,_=run(b'',broken_read=failed)
        self.stopped(result,handle,'OSError')

    def test_absent_uid_keeps_strict_legacy_path(self):
        result,handle,_=run(b'\0'+ACK,uid=None)
        self.stopped(result,handle,'StcFramingException')
        self.assertIsNone(result['eraseReception'])
        result,_,_=run(uid=None); self.assertTrue(result['ok'],result)
        self.assertIsNone(result['eraseReception'])

    def test_unsupported_live_bsl_and_clock_stop_before_handshake(self):
        for change in (lambda s:s.__setitem__(22,0x71),lambda s:s.__setitem__(12,s[12]&0xfe)):
            result,handle,_=run(change_status=change)
            self.assertFalse(result['ok']); self.assertEqual(result['error'],'ERASE_RX_PROFILE')
            self.assertFalse(result['eraseStarted']); self.assertEqual(handle.command_index,0)

    def test_bad_uid_request_never_constructs_serial_or_image(self):
        for value in (None,True,14,'gg'*7,'00'*6,'00'*7+'\n'):
            spec=request(); spec['expectedUid']=value
            with patch.object(isp,'load_image',side_effect=AssertionError('image must not load')):
                result=isp.run_session(spec,factory=lambda _:self.fail('factory called'),emit=lambda _:None)
            self.assertFalse(result['ok']); self.assertFalse(result['eraseStarted'])
            self.assertEqual(result['error'],'BAD_SESSION_PARAMETERS')

    def test_parser_fragment_boundaries_and_maximum_checksum_carry(self):
        for cut in range(len(ACK)+1):
            parser=receiver.FrameSearch()
            self.assertEqual(parser.feed(ACK[:cut])+parser.feed(ACK[cut:]),[b'\x03'+bytes.fromhex(UID)])
        parser=receiver.FrameSearch()
        self.assertEqual([p for byte in ACK for p in parser.feed(bytes([byte]))],[b'\x03'+bytes.fromhex(UID)])
        self.assertEqual(receiver.FrameSearch().feed(packet(0x68,b'\xff'*249)),[b'\xff'*249])

    def test_preexisting_different_uid_is_rejected_before_original_erase(self):
        from types import SimpleNamespace
        state=SimpleNamespace(mcu_magic=0xf449,mcu_bsl_version='7.2.5S',external_clock=False,uid=b'\xff'*7)
        with self.assertRaises(receiver.ReceiveError) as raised: receiver.prepare(state,UID)
        self.assertEqual(raised.exception.code,'ERASE_RX_UID_MISMATCH')


class NativeTimeoutTests(unittest.TestCase):
    def exercise(self, *, get_ok=True, sets=(True,True), primary=None):
        from types import SimpleNamespace
        evidence={'nativeTimeouts':{},'cleanupErrors':[]}; snapshots=[]
        def get(handle,pointer):
            for i,(name,*_) in enumerate(win32.COMMTIMEOUTS._fields_): setattr(pointer._obj,name,21+i)
            return get_ok
        def set_(handle,pointer):
            snapshots.append([int(getattr(pointer._obj,name)) for name,*_ in win32.COMMTIMEOUTS._fields_])
            return sets[len(snapshots)-1]
        error=None
        with patch.object(win32,'GetCommTimeouts',side_effect=get),patch.object(win32,'SetCommTimeouts',side_effect=set_),patch.object(win32,'GetLastError',return_value=5):
            try:
                with receiver.native_nonblocking(SimpleNamespace(_port_handle=123),evidence):
                    if primary: raise primary
            except Exception as exc: error=exc
        return evidence,snapshots,error

    def test_five_field_snapshot_write_preservation_and_restore(self):
        evidence,snapshots,error=self.exercise()
        self.assertIsNone(error); self.assertEqual(snapshots,[[0xffffffff,0,0,24,25],[21,22,23,24,25]])
        self.assertTrue(evidence['nativeTimeouts']['restored'])

    def test_get_set_and_restore_errors_use_native_error_slot(self):
        evidence,snapshots,error=self.exercise(get_ok=False)
        self.assertEqual(error.winerror,5); self.assertEqual(snapshots,[])
        evidence,snapshots,error=self.exercise(sets=(False,True))
        self.assertEqual(error.winerror,5); self.assertTrue(evidence['nativeTimeouts']['restored'])
        evidence,snapshots,error=self.exercise(sets=(True,False))
        self.assertEqual(error.code,'ERASE_RX_TIMEOUT_RESTORE')
        self.assertEqual(evidence['cleanupErrors'][0]['winerror'],5)

    def test_restore_error_does_not_replace_primary_failure(self):
        primary=OSError('original')
        evidence,_,error=self.exercise(sets=(True,False),primary=primary)
        self.assertIs(error,primary); self.assertEqual(len(evidence['cleanupErrors']),1)


if __name__=='__main__': unittest.main(verbosity=2)
