import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(import.meta.dirname, '..');
const OXLINT = path.join(ROOT, 'node_modules', '.bin', 'oxlint');

// These scripts load on the e-reader page, which runs on old Kobo WebKit (538.1):
// no `let`, template literals, or optional catch bindings.
const EREADER_SCRIPTS = ['client/public/download.js', 'client/public/theme.js'];

describe('oxlint --fix (run by the pre-commit hook)', () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lint-config-'));
    const config = JSON.parse(await fsp.readFile(path.join(ROOT, '.oxlintrc.json'), 'utf8'));
    delete config.$schema;
    await fsp.writeFile(path.join(tmpDir, '.oxlintrc.json'), JSON.stringify(config));
    for (const script of EREADER_SCRIPTS) {
      await fsp.mkdir(path.join(tmpDir, path.dirname(script)), { recursive: true });
      await fsp.copyFile(path.join(ROOT, script), path.join(tmpDir, script));
    }
  });

  after(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('leaves e-reader scripts unchanged', async () => {
    await execFileAsync(OXLINT, ['--fix', '-c', '.oxlintrc.json', 'client/public'], {
      cwd: tmpDir,
    });
    for (const script of EREADER_SCRIPTS) {
      const original = await fsp.readFile(path.join(ROOT, script), 'utf8');
      const fixed = await fsp.readFile(path.join(tmpDir, script), 'utf8');
      assert.equal(fixed, original, `oxlint --fix rewrote ${script}`);
    }
  });
});
