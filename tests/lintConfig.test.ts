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

// These scripts load on the e-reader page, which must be plain ES5 (see koboSyntax.test.ts).
const EREADER_SCRIPTS = ['client/public/download.js', 'client/public/theme.js'];

describe('oxlint config for e-reader scripts', () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lint-config-'));
    const config = JSON.parse(await fsp.readFile(path.join(ROOT, '.oxlintrc.json'), 'utf8'));
    delete config.$schema;
    config.jsPlugins = (config.jsPlugins ?? []).map((p: string) => path.resolve(ROOT, p));
    await fsp.writeFile(path.join(tmpDir, '.oxlintrc.json'), JSON.stringify(config));
    for (const script of EREADER_SCRIPTS) {
      await fsp.mkdir(path.join(tmpDir, path.dirname(script)), { recursive: true });
      await fsp.copyFile(path.join(ROOT, script), path.join(tmpDir, script));
    }
  });

  after(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('oxlint --fix (run by the pre-commit hook) leaves them unchanged', async () => {
    await execFileAsync(OXLINT, ['--fix', '-c', '.oxlintrc.json', 'client/public'], {
      cwd: tmpDir,
    });
    for (const script of EREADER_SCRIPTS) {
      const original = await fsp.readFile(path.join(ROOT, script), 'utf8');
      const fixed = await fsp.readFile(path.join(tmpDir, script), 'utf8');
      assert.equal(fixed, original, `oxlint --fix rewrote ${script}`);
    }
  });

  it('reports syntax newer than ES5 in them', async () => {
    const script = path.join(tmpDir, 'client', 'public', 'theme.js');
    const original = await fsp.readFile(script, 'utf8');
    await fsp.writeFile(script, 'var a = 1;\nconst b = 2;\n');
    try {
      const result = await execFileAsync(
        OXLINT,
        ['-c', '.oxlintrc.json', '--format', 'unix', 'client/public/theme.js'],
        { cwd: tmpDir }
      ).catch((err: { stdout: string }) => err);
      assert.match(result.stdout, /theme\.js:2:\d+: .*'const'.*es5\(syntax\)/);
    } finally {
      await fsp.writeFile(script, original);
    }
  });
});
