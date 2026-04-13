import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import express from 'express';
import { makeRequireKey, makeRequireMatchingAgent } from '../src/middleware.js';
import type { KeyInfo } from '../src/types.js';

function makeKeyInfo(agent: string): KeyInfo {
  return {
    created: new Date(),
    ip: '127.0.0.1',
    agent,
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

// ---------------------------------------------------------------------------
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

  it('calls next and populates res.locals for a valid key', async () => {
    const keys = new Map<string, KeyInfo>();
    keys.set('ACDF', makeKeyInfo('TestBrowser/1.0'));
    const app = makeApp(makeRequireKey(keys));
    const res = await request(app).get('/ACDF');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.key, 'ACDF');
    assert.strictEqual(res.body.hasInfo, true);
  });
});

// ---------------------------------------------------------------------------
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

  it('returns 403 when user-agent does not match', async () => {
    const keys = new Map<string, KeyInfo>();
    keys.set('ACDF', makeKeyInfo('AgentA/1.0'));
    const app = makeApp(makeRequireMatchingAgent(keys));
    const res = await request(app).get('/ACDF').set('User-Agent', 'AgentB/1.0');
    assert.strictEqual(res.status, 403);
  });

  it('calls next and populates res.locals when key and user-agent match', async () => {
    const keys = new Map<string, KeyInfo>();
    keys.set('ACDF', makeKeyInfo('TestBrowser/1.0'));
    const app = makeApp(makeRequireMatchingAgent(keys));
    const res = await request(app).get('/ACDF').set('User-Agent', 'TestBrowser/1.0');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.key, 'ACDF');
    assert.strictEqual(res.body.hasInfo, true);
  });
});
