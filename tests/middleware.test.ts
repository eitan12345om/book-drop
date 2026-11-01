import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import express from 'express';
import {
  makeRequireKey,
  makeRequireMatchingAgent,
  makeLimiter,
  requireXhr,
  readCookie,
  hasReceiverToken,
} from '../src/middleware.js';
import type { KeyInfo } from '../src/types.js';

const TOKEN = 'k3Zp-secret_token';
const COOKIE = `bd_ACDF=${TOKEN}`;

function makeKeyInfo(agent: string): KeyInfo {
  return {
    created: new Date(),
    ip: '127.0.0.1',
    network: '127.0.0.1',
    agent,
    token: TOKEN,
    files: [],
    urls: [],
    timer: null,
    pendingUploads: 0,
    pendingFilenames: [],
    alive: new Date(),
  };
}

function makeApp(middleware: express.RequestHandler) {
  const app = express();
  app.get('/:key', middleware, (_req, res) => {
    res.json({ key: res.locals.key, hasInfo: !!res.locals.keyInfo });
  });
  return app;
}

describe('readCookie', () => {
  it('returns the value of the named cookie', () => {
    assert.strictEqual(readCookie('a=1; bd_ACDF=xyz; b=2', 'bd_ACDF'), 'xyz');
  });

  it('returns undefined when the cookie is absent or there is no header', () => {
    assert.strictEqual(readCookie('a=1; bd_ACDFX=xyz', 'bd_ACDF'), undefined);
    assert.strictEqual(readCookie(undefined, 'bd_ACDF'), undefined);
  });

  it('keeps an "=" inside the value', () => {
    assert.strictEqual(readCookie('bd_ACDF=ab=c', 'bd_ACDF'), 'ab=c');
  });
});

describe('hasReceiverToken', () => {
  const withCookie = (cookie?: string) =>
    ({ headers: cookie === undefined ? {} : { cookie } }) as express.Request;
  const info = makeKeyInfo('TestBrowser/1.0');

  it('accepts the session secret under the cookie named for the key', () => {
    assert.strictEqual(hasReceiverToken(withCookie(COOKIE), 'ACDF', info), true);
  });

  it('rejects a missing cookie, a wrong secret, and the secret under another key', () => {
    assert.strictEqual(hasReceiverToken(withCookie(), 'ACDF', info), false);
    assert.strictEqual(
      hasReceiverToken(withCookie(`bd_ACDF=${'x'.repeat(17)}`), 'ACDF', info),
      false
    );
    assert.strictEqual(hasReceiverToken(withCookie(`bd_ZZZZ=${TOKEN}`), 'ACDF', info), false);
  });

  it('rejects secrets of a different length without throwing', () => {
    assert.strictEqual(hasReceiverToken(withCookie('bd_ACDF=short'), 'ACDF', info), false);
    assert.strictEqual(hasReceiverToken(withCookie(`${COOKIE}extra`), 'ACDF', info), false);
    assert.strictEqual(hasReceiverToken(withCookie('bd_ACDF='), 'ACDF', info), false);
  });
});

describe('makeRequireKey', () => {
  it('returns 400 for an invalid key format', async () => {
    const app = makeApp(makeRequireKey(new Map()));
    const res = await request(app).get('/!!');
    assert.strictEqual(res.status, 400);
  });

  it('returns 404 for an unknown key', async () => {
    const app = makeApp(makeRequireKey(new Map()));
    const res = await request(app).get('/ZZZZ');
    assert.strictEqual(res.status, 404);
    assert.ok('error' in res.body);
  });

  it('answers a missing or wrong session cookie as an unknown key', async () => {
    const keys = new Map<string, KeyInfo>();
    keys.set('ACDF', makeKeyInfo('TestBrowser/1.0'));
    const app = makeApp(makeRequireKey(keys));
    for (const cookie of ['', 'bd_ACDF=wrong']) {
      const res = await request(app).get('/ACDF').set('Cookie', cookie);
      assert.strictEqual(res.status, 404);
      assert.deepStrictEqual(res.body, { error: 'Unknown key.' });
    }
  });

  it('calls next and populates res.locals for a valid key and cookie', async () => {
    const keys = new Map<string, KeyInfo>();
    keys.set('ACDF', makeKeyInfo('TestBrowser/1.0'));
    const app = makeApp(makeRequireKey(keys));
    const res = await request(app).get('/ACDF').set('Cookie', COOKIE);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.key, 'ACDF');
    assert.strictEqual(res.body.hasInfo, true);
  });
});

describe('makeRequireMatchingAgent', () => {
  it('returns 400 for an invalid key format', async () => {
    const app = makeApp(makeRequireMatchingAgent(new Map()));
    const res = await request(app).get('/!!');
    assert.strictEqual(res.status, 400);
  });

  it('returns 404 for an unknown key', async () => {
    const app = makeApp(makeRequireMatchingAgent(new Map()));
    const res = await request(app).get('/ZZZZ').set('User-Agent', 'TestBrowser');
    assert.strictEqual(res.status, 404);
    assert.ok('error' in res.body);
  });

  it('returns 404 when user-agent does not match', async () => {
    const keys = new Map<string, KeyInfo>();
    keys.set('ACDF', makeKeyInfo('AgentA/1.0'));
    const app = makeApp(makeRequireMatchingAgent(keys));
    const res = await request(app)
      .get('/ACDF')
      .set('User-Agent', 'AgentB/1.0')
      .set('Cookie', COOKIE);
    assert.strictEqual(res.status, 404);
  });

  it('returns 404 when the user-agent matches but the session cookie is missing', async () => {
    const keys = new Map<string, KeyInfo>();
    keys.set('ACDF', makeKeyInfo('TestBrowser/1.0'));
    const app = makeApp(makeRequireMatchingAgent(keys));
    const res = await request(app).get('/ACDF').set('User-Agent', 'TestBrowser/1.0');
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(res.body, { error: 'Unknown key.' });
  });

  it('calls next and populates res.locals when key, user-agent and cookie match', async () => {
    const keys = new Map<string, KeyInfo>();
    keys.set('ACDF', makeKeyInfo('TestBrowser/1.0'));
    const app = makeApp(makeRequireMatchingAgent(keys));
    const res = await request(app)
      .get('/ACDF')
      .set('User-Agent', 'TestBrowser/1.0')
      .set('Cookie', COOKIE);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.key, 'ACDF');
    assert.strictEqual(res.body.hasInfo, true);
  });
});

describe('makeLimiter', () => {
  it('counts every address in an IPv6 /56 as one client', async () => {
    const app = express();
    app.get('/', makeLimiter(2), (_req, res) => res.send('ok'));
    const send = (ip: string) => request(app).get('/').set('CF-Connecting-IP', ip);

    assert.strictEqual((await send('2001:db8:1:ab00::1')).status, 200);
    assert.strictEqual((await send('2001:db8:1:ab01::2')).status, 200);
    assert.strictEqual((await send('2001:db8:1:abff::3')).status, 429);
    assert.strictEqual((await send('2001:db8:1:ac00::1')).status, 200);
  });
});

describe('requireXhr', () => {
  function makeXhrApp() {
    const app = express();
    app.post('/test', requireXhr, (_req, res) => res.json({ ok: true }));
    return app;
  }

  it('returns 403 when X-Requested-With header is absent', async () => {
    const res = await request(makeXhrApp()).post('/test');
    assert.strictEqual(res.status, 403);
  });

  it('returns 403 when X-Requested-With has wrong value', async () => {
    const res = await request(makeXhrApp()).post('/test').set('X-Requested-With', 'form');
    assert.strictEqual(res.status, 403);
  });

  it('calls next when X-Requested-With is XMLHttpRequest', async () => {
    const res = await request(makeXhrApp()).post('/test').set('X-Requested-With', 'XMLHttpRequest');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { ok: true });
  });
});
