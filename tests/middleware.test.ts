import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import express from 'express';
import { makeRequireKey, makeRequireMatchingAgent } from '../src/middleware.js';
import { sanitiseFilename } from '../src/routes/upload.js';
import type { KeyInfo } from '../src/types.js';

function makeKeyInfo(agent: string): KeyInfo {
  return {
    created: new Date(),
    agent,
    file: null,
    urls: [],
    timer: null,
    downloadTimer: null,
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

// ---------------------------------------------------------------------------
describe('sanitiseFilename', () => {
  it('leaves a plain ASCII filename unchanged', () => {
    assert.strictEqual(
      sanitiseFilename('book.epub', { transliterate: false, isKindle: false }),
      'book.epub'
    );
  });

  it('transliterates accented characters when enabled', () => {
    const result = sanitiseFilename('Üntergang.epub', { transliterate: true, isKindle: false });
    assert.ok(!result.includes('Ü'), 'accented char should be replaced');
    assert.ok(result.endsWith('.epub'));
  });

  it('does not transliterate when disabled', () => {
    const result = sanitiseFilename('Üntergang.epub', { transliterate: false, isKindle: false });
    assert.ok(result.includes('Ü'));
  });

  it('replaces non-ASCII characters with underscores for Kindle', () => {
    const result = sanitiseFilename('Le Château.epub', { transliterate: false, isKindle: true });
    assert.ok(!result.includes('â'), 'accented char should be replaced');
    assert.ok(!result.includes(' '), 'space should be replaced');
    assert.ok(result.endsWith('.epub'));
  });

  it('preserves Kindle-safe ASCII characters on Kindle', () => {
    const result = sanitiseFilename('My-Book-(2024).epub', {
      transliterate: false,
      isKindle: true,
    });
    assert.strictEqual(result, 'My-Book-(2024).epub');
  });

  it('applies transliteration before Kindle restriction', () => {
    // transliterate first (Ü→U), then Kindle pass should leave U untouched
    const result = sanitiseFilename('Über.epub', { transliterate: true, isKindle: true });
    assert.ok(!result.includes('Ü'));
    assert.ok(result.endsWith('.epub'));
  });
});
