import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

// CI installs the pnpm from package.json's packageManager; the image builds with the one
// copied from ghcr.io/pnpm/pnpm. Dependabot bumps these separately, so pin them together.

const ROOT = path.resolve(import.meta.dirname, '..');

describe('pnpm version', () => {
  it('matches between package.json packageManager and the Dockerfile', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      packageManager: string;
    };
    const expected = /^pnpm@(\d+\.\d+\.\d+)$/.exec(pkg.packageManager)?.[1];
    assert.ok(expected, `unexpected packageManager: ${pkg.packageManager}`);

    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
    const images = [...dockerfile.matchAll(/ghcr\.io\/pnpm\/pnpm:(\S+)/g)].map((m) => m[1]);
    assert.ok(images.length > 0, 'no ghcr.io/pnpm/pnpm image in Dockerfile');
    assert.deepStrictEqual(
      images,
      images.map(() => expected)
    );
  });
});
