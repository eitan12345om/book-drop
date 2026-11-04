import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import supertest from 'supertest';
import JSZip from 'jszip';
import type { Application } from 'express';

// Config is read once on import, and node --test gives each file its own process, so
// these settings reach the app without leaking into the other test files.
const uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'conversion-route-uploads-'));
const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-ebook-convert-'));
const startedMarker = path.join(fakeBinDir, 'started');
Object.assign(process.env, {
  UPLOAD_DIR: uploadDir,
  CONVERSION_TIMEOUT_MS: '1000',
  MAX_CONCURRENT_CONVERSIONS: '1',
  MAX_QUEUED_CONVERSIONS: '0',
  KOBO_CONVERTER: 'calibre',
  MAX_KEYS_PER_IP: '10',
  PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
});
const { createApp } = await import('../src/app.js');

// FAKE_CONVERTER is read when the converter is spawned, so each test picks its own failure.
await fs.writeFile(
  path.join(fakeBinDir, 'ebook-convert'),
  `#!/bin/sh
touch "${startedMarker}"
case "$FAKE_CONVERTER" in
  hang) exec sleep 30 ;;
  *) echo 'ValueError: not a valid EPUB file (could not find opf)'; exit 1 ;;
esac
`,
  { mode: 0o755 }
);

let server: http.Server;
let app: Application;

before(async () => {
  ({ app } = createApp());
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(uploadDir, { recursive: true, force: true });
  await fs.rm(fakeBinDir, { recursive: true, force: true });
});

const request = () => supertest(server);

async function generateKoboKey(): Promise<string> {
  const res = await request()
    .post('/generate')
    .set('X-Forwarded-Proto', 'https')
    .set('X-Requested-With', 'XMLHttpRequest')
    .set('User-Agent', 'Kobo/1.0 Test');
  return res.body.key as string;
}

async function uploadForKobo(key: string) {
  return request()
    .post('/upload')
    .set('X-Forwarded-Proto', 'https')
    .set('X-Requested-With', 'XMLHttpRequest')
    .field('key', key)
    .field('kobo', 'true')
    .attach('file', await new JSZip().generateAsync({ type: 'nodebuffer' }), {
      filename: 'book.epub',
      contentType: 'application/epub+zip',
    });
}

async function waitForConverterToStart(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      await fs.access(startedMarker);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error('the fake converter never started');
}

describe('POST /upload — how conversion failures are answered', () => {
  it('answers a book the converter rejects with 422, the device guidance, and a reference', async () => {
    process.env.FAKE_CONVERTER = 'fail';
    const res = await uploadForKobo(await generateKoboKey());
    assert.strictEqual(res.status, 422);
    assert.match(res.body.error, /Kobo format/);
    assert.match(res.body.ref, /^[0-9A-F]{8}$/);
    assert.deepStrictEqual(await fs.readdir(uploadDir), []);
  });

  it('answers a conversion that runs past the timeout with 504 and the guidance', async () => {
    process.env.FAKE_CONVERTER = 'hang';
    const startedAt = Date.now();
    const res = await uploadForKobo(await generateKoboKey());
    const elapsed = Date.now() - startedAt;
    assert.strictEqual(res.status, 504);
    assert.match(res.body.error, /Kobo format/);
    assert.match(res.body.ref, /^[0-9A-F]{8}$/);
    assert.ok(elapsed < 3_000, `took ${elapsed} ms`);
    assert.deepStrictEqual(await fs.readdir(uploadDir), []);
  });

  it('refuses an upload with 503 and Retry-After while every slot is busy', async () => {
    process.env.FAKE_CONVERTER = 'hang';
    await fs.rm(startedMarker, { force: true });
    const busy = uploadForKobo(await generateKoboKey());
    await waitForConverterToStart();

    const res = await uploadForKobo(await generateKoboKey());
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.headers['retry-after'], '30');
    assert.match(res.body.error, /Too many conversions/);

    assert.strictEqual((await busy).status, 504);
  });
});
