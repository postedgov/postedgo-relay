import importlib.util
import json
from pathlib import Path
import unittest
from urllib.error import HTTPError, URLError

spec = importlib.util.spec_from_file_location('reply', Path(__file__).with_name('reply.py'))
helper = None
try:
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
except FileNotFoundError:
    helper = None

class ReplyTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(helper, 'The callback helper must exist')
        self.envelope = {'requestId':'12345678-1234-4234-8234-123456789abc', 'callback':{'url':'https://quiet-river-room.trycloudflare.com/result','token':'a'*64},'prompt':'Say hello'}

    def test_exact_authenticated_body_and_redaction(self):
        class Response:
            status = 200
            def __enter__(self): return self
            def __exit__(self,*args): pass
        class Sender:
            calls = []
            def open(self, request, timeout):
                self.calls.append(request)
                return Response()
        sender = Sender()
        helper.send_reply(self.envelope, 'Hello '+self.envelope['callback']['token'], opener=sender)
        self.assertEqual(len(sender.calls),1)
        request = sender.calls[0]
        self.assertEqual(request.method,'POST')
        self.assertEqual(request.get_header('Authorization'),'Bearer '+'a'*64)
        self.assertEqual(json.loads(request.data),{'requestId':self.envelope['requestId'],'text':'Hello [redacted]'})

    def test_rejects_unsafe_destinations_and_incomplete_envelopes(self):
        for url in ['http://quiet-river-room.trycloudflare.com/result','https://trycloudflare.com.evil.example/result','https://quiet-river-room.trycloudflare.com/api/state','https://a@quiet-river-room.trycloudflare.com/result','https://quiet-river-room.trycloudflare.com:443/result','https://quiet-river-room.trycloudflare.com/result?key=x','https://127.0.0.1/result']:
            with self.subTest(url=url):
                self.envelope['callback']['url']=url
                with self.assertRaises(ValueError): helper.prepare_reply(self.envelope,'Hello')
        self.envelope['callback']['url']='https://quiet-river-room.trycloudflare.com/result'
        for field in ['requestId','callback','prompt']:
            broken=dict(self.envelope);broken.pop(field)
            with self.assertRaises(ValueError): helper.prepare_reply(broken,'Hello')
        for token in ['short','b'*64+'\n']:
            self.envelope['callback']['token']=token
            with self.assertRaises(ValueError): helper.prepare_reply(self.envelope,'Hello')

    def test_response_limits_and_error_shape(self):
        for reply in ['', ' '*8, 'x'*500001, '\x00'*200000]:
            with self.assertRaises(ValueError): helper.prepare_reply(self.envelope,reply)
        _,_,body=helper.prepare_reply(self.envelope,'Cannot finish',is_error=True)
        self.assertEqual(json.loads(body),{'requestId':self.envelope['requestId'],'error':'Cannot finish'})
        with self.assertRaises(ValueError): helper.prepare_reply(self.envelope,'x'*4001,is_error=True)

    def test_network_failures_are_not_retried_and_do_not_expose_credentials(self):
        for error in [HTTPError(self.envelope['callback']['url'],302,'redirect',{},None),URLError(self.envelope['callback']['token'])]:
            class Sender:
                count=0
                def open(self,request,timeout):
                    self.count+=1
                    raise error
            sender=Sender()
            with self.assertRaises(RuntimeError) as caught:helper.send_reply(self.envelope,'Hello',opener=sender)
            self.assertEqual(sender.count,1)
            self.assertNotIn(self.envelope['callback']['token'],str(caught.exception))
            self.assertNotIn(self.envelope['callback']['url'],str(caught.exception))
        self.assertIsNone(helper.NoRedirect().redirect_request(None,None,302,'redirect',{},'https://other.example'))

if __name__=='__main__': unittest.main()
