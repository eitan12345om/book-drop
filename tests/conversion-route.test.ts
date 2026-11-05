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
const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-converters-'));
const startedMarker = path.join(fakeBinDir, 'started');
Object.assign(process.env, {
  UPLOAD_DIR: uploadDir,
  CONVERSION_TIMEOUT_MS: '1000',
  MAX_CONCURRENT_CONVERSIONS: '1',
  MAX_QUEUED_CONVERSIONS: '1',
  MAX_KEYS_PER_IP: '10',
  PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
});
const { createApp } = await import('../src/app.js');
const { convert } = await import('../src/converter.js');

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
await fs.writeFile(
  path.join(fakeBinDir, 'kepubify'),
  `#!/bin/sh
while [ "$#" -gt 1 ]; do case "$1" in -o) out="$2"; shift ;; esac; shift; done
: > "$out"
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

type Device = 'Kindle' | 'Kobo';

async function generateKey(device: Device): Promise<string> {
  const res = await request()
    .post('/generate')
    .set('X-Forwarded-Proto', 'https')
    .set('X-Requested-With', 'XMLHttpRequest')
    .set('User-Agent', device === 'Kindle' ? 'Kindle/3.0 Test' : 'Kobo/1.0 Test');
  return res.body.key as string;
}

async function uploadFor(device: Device, key: string) {
  return request()
    .post('/upload')
    .set('X-Forwarded-Proto', 'https')
    .set('X-Requested-With', 'XMLHttpRequest')
    .field('key', key)
    .field(device.toLowerCase(), 'true')
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
    const res = await uploadFor('Kindle', await generateKey('Kindle'));
    assert.strictEqual(res.status, 422);
    assert.match(res.body.error, /Kindle format/);
    assert.match(res.body.ref, /^[0-9A-F]{8}$/);
    assert.deepStrictEqual(await fs.readdir(uploadDir), []);
  });

  it('answers a conversion that runs past the timeout with 504 and the guidance', async () => {
    process.env.FAKE_CONVERTER = 'hang';
    const startedAt = Date.now();
    const res = await uploadFor('Kindle', await generateKey('Kindle'));
    const elapsed = Date.now() - startedAt;
    assert.strictEqual(res.status, 504);
    assert.match(res.body.error, /Kindle format/);
    assert.match(res.body.ref, /^[0-9A-F]{8}$/);
    assert.ok(elapsed < 3_000, `took ${elapsed} ms`);
    assert.deepStrictEqual(await fs.readdir(uploadDir), []);
  });

  it('refuses an upload with 503 and Retry-After while every slot and the queue are full', async () => {
    process.env.FAKE_CONVERTER = 'hang';
    await fs.rm(startedMarker, { force: true });
    const busy = uploadFor('Kindle', await generateKey('Kindle'));
    await waitForConverterToStart();
    const queued = assert.rejects(convert('kindle', path.join(uploadDir, 'queued.epub')));

    const res = await uploadFor('Kindle', await generateKey('Kindle'));
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.headers['retry-after'], '30');
    assert.match(res.body.error, /Too many conversions/);

    assert.strictEqual((await busy).status, 504);
    await queued;
  });

  it('converts a Kobo upload with kepubify straight away while every slot and the queue are full', async () => {
    process.env.FAKE_CONVERTER = 'hang';
    await fs.rm(startedMarker, { force: true });
    const busy = uploadFor('Kindle', await generateKey('Kindle'));
    await waitForConverterToStart();
    const queued = assert.rejects(convert('kindle', path.join(uploadDir, 'queued.epub')));

    const res = await uploadFor('Kobo', await generateKey('Kobo'));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.conversionTool, 'Kepubify');

    assert.strictEqual((await busy).status, 504);
    await queued;
  });

  it('times a conversion from when it gets a slot, not from when it joined the queue', async () => {
    process.env.FAKE_CONVERTER = 'hang';
    await fs.rm(startedMarker, { force: true });
    const first = {};
    const second: { queuedMs?: number; durationMs?: number } = {};
    const running = assert.rejects(convert('kindle', path.join(uploadDir, 'first.epub'), first));
    await waitForConverterToStart();
    process.env.FAKE_CONVERTER = 'fail';
    const waiting = assert.rejects(convert('kindle', path.join(uploadDir, 'second.epub'), second));
    await Promise.all([running, waiting]);

    assert.ok(second.queuedMs! >= 800, `queued ${second.queuedMs} ms behind a 1 s conversion`);
    assert.ok(second.durationMs! < 500, `ran ${second.durationMs} ms for an instant failure`);
  });
});
