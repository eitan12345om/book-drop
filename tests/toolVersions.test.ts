import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';

// converter-updates.yml relies on this script to find the pins; if the Dockerfile
// changes shape, these fail on that PR rather than in a later scheduled run.

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'pinned-tool-versions.mjs');

async function pins(...args: string[]): Promise<{ name: string; repo: string; pinned: string }[]> {
  const { stdout } = await execFileAsync(process.execPath, [SCRIPT, ...args]);
  return JSON.parse(stdout);
}

describe('pinned-tool-versions script', () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tool-versions-'));
  });

  after(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('finds every converter pin in the Dockerfile', async () => {
    const found = await pins();
    assert.deepStrictEqual(
      found.map(({ name, repo }) => [name, repo]),
      [['kepubify', 'pgaskin/kepubify']]
    );
    for (const { name, pinned } of found) {
      assert.match(pinned, /^\d+\.\d+\.\d+$/, `${name} pin: ${pinned}`);
    }
  });

  it('reports the versions as written, without a leading v', async () => {
    const dockerfile = path.join(tmpDir, 'Dockerfile');
    await fsp.writeFile(
      dockerfile,
      'RUN go install github.com/pgaskin/kepubify/v4/cmd/kepubify@v4.5.6\n'
    );
    assert.deepStrictEqual(
      (await pins(dockerfile)).map((p) => p.pinned),
      ['4.5.6']
    );
  });

  it('fails, naming the tool, when a pin is missing', async () => {
    const dockerfile = path.join(tmpDir, 'Dockerfile');
    await fsp.writeFile(dockerfile, 'FROM node:26-slim\n');
    await assert.rejects(pins(dockerfile), (err: { code: number; stderr: string }) => {
      assert.strictEqual(err.code, 1);
      assert.match(err.stderr, /kepubify/);
      return true;
    });
  });
});
