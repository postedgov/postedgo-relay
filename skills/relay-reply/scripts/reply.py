#!/usr/bin/env python3
"""Send one Relay callback without exposing its temporary credential."""
import argparse
import json
from pathlib import Path
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def prepare_reply(envelope, text, is_error=False):
    if not isinstance(envelope, dict) or not isinstance(envelope.get('callback'), dict):
        raise ValueError('A complete Relay webhook envelope is required.')
    request_id = envelope.get('requestId')
    prompt = envelope.get('prompt')
    callback = envelope['callback']
    url, token = callback.get('url'), callback.get('token')
    if not isinstance(request_id, str) or not re.fullmatch(r'[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}', request_id):
        raise ValueError('The Relay request identifier is invalid.')
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 20000:
        raise ValueError('The Relay prompt is missing or too large.')
    if not isinstance(url, str) or not re.fullmatch(r'https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com/result', url):
        raise ValueError('The callback must be the temporary Relay HTTPS result endpoint.')
    if not isinstance(token, str) or not re.fullmatch(r'[a-f0-9]{64}', token):
        raise ValueError('The temporary Relay credential is missing or invalid.')
    limit = 4000 if is_error else 500000
    if not isinstance(text, str) or not text.strip() or len(text.encode('utf-16-le')) // 2 > limit:
        raise ValueError('Reply text is empty or too large.')
    text = text.replace(token, '[redacted]')
    data = json.dumps({'requestId': request_id, 'error' if is_error else 'text': text}, ensure_ascii=False).encode('utf-8')
    if len(data) > 1000000:
        raise ValueError('The encoded reply exceeds the callback body limit.')
    return url, token, data

def send_reply(envelope, text, is_error=False, opener=None):
    url, token, data = prepare_reply(envelope, text, is_error)
    request = Request(url, data=data, method='POST', headers={'Authorization': 'Bearer '+token, 'Content-Type': 'application/json'})
    try:
        with (opener or build_opener(NoRedirect())).open(request, timeout=20) as response:
            if response.status != 200:
                raise RuntimeError('Relay did not accept the reply. Do not retry this callback.')
    except HTTPError as error:
        error.close()
        raise RuntimeError('Relay returned HTTP '+str(error.code)+'. Do not retry this callback.') from None
    except (URLError, TimeoutError, OSError):
        raise RuntimeError('Reply delivery was not confirmed. Do not retry; the first attempt may have arrived.') from None

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('request_file', type=Path)
    parser.add_argument('reply_file', type=Path)
    parser.add_argument('--error', action='store_true', help='Return a short failure instead of an answer')
    args = parser.parse_args()
    try:
        with args.request_file.open('rb') as stream:
            raw = stream.read(16385)
        if len(raw) > 16384:
            raise ValueError('The webhook envelope is too large.')
        with args.reply_file.open('rb') as stream:
            reply = stream.read(1000001)
        if len(reply) > 1000000:
            raise ValueError('The reply file is too large.')
        send_reply(json.loads(raw), reply.decode('utf-8'), args.error)
    except (OSError, UnicodeError, ValueError, RuntimeError):
        print('Reply could not be confirmed. Check the input and Relay task status; do not automatically retry.', file=sys.stderr)
        return 1
    print('Reply delivered to Relay.')
    return 0

if __name__ == '__main__':
    sys.exit(main())
