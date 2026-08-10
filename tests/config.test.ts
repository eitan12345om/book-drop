import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { envChoice, envCount, envInt } from '../src/config.js';

const KEY = 'BOOK_DROP_TEST_CHOICE';
const CONVERTERS = ['calibre', 'kepubify'] as const;

afterEach(() => {
  delete process.env[KEY];
});

describe('envChoice', () => {
  it('returns the value when it is one of the allowed choices', () => {
    process.env[KEY] = 'kepubify';
    assert.strictEqual(envChoice(KEY, CONVERTERS, 'calibre'), 'kepubify');
  });

  it('accepts stray case and whitespace, which survive most .env files', () => {
    process.env[KEY] = '  KePubify \n';
    assert.strictEqual(envChoice(KEY, CONVERTERS, 'calibre'), 'kepubify');
  });

  it('falls back on a value it does not recognise', () => {
    process.env[KEY] = 'kepubifyy';
    assert.strictEqual(envChoice(KEY, CONVERTERS, 'calibre'), 'calibre');
  });

  it('falls back on an empty value, as set-but-blank means unconfigured in a .env file', () => {
    process.env[KEY] = '';
    assert.strictEqual(envChoice(KEY, CONVERTERS, 'calibre'), 'calibre');
  });
});

/** Reads the conversion limits as a fresh process would, since they are set on import. */
function limitsUnderEnv(env: Record<string, string>): Record<string, number> {
  const script = `
    const c = await import('./src/config.js');
    console.log(JSON.stringify({
      concurrent: c.MAX_CONCURRENT_CONVERSIONS,
      queued: c.MAX_QUEUED_CONVERSIONS,
    }));
  `;
  const stdout = execFileSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', script],
    { env: { ...process.env, ...env, LOG_LEVEL: 'silent' }, encoding: 'utf8' }
  );
  return JSON.parse(stdout.trim().split('\n').at(-1) as string);
}

describe('conversion limits', () => {
  it('runs one conversion per CPU the container was given', () => {
    assert.deepStrictEqual(limitsUnderEnv({ CPUS: '2.0' }), { concurrent: 2, queued: 4 });
  });

  it('holds a fraction of a CPU to a single conversion', () => {
    assert.deepStrictEqual(limitsUnderEnv({ CPUS: '0.5' }), { concurrent: 1, queued: 2 });
  });

  it('caps the default, since memory runs out before cores do', () => {
    assert.deepStrictEqual(limitsUnderEnv({ CPUS: '16' }), { concurrent: 4, queued: 8 });
  });

  it('lets an explicit limit past the cap, queue following it', () => {
    assert.deepStrictEqual(limitsUnderEnv({ CPUS: '16', MAX_CONCURRENT_CONVERSIONS: '8' }), {
      concurrent: 8,
      queued: 16,
    });
  });
});

describe('envCount', () => {
  it('refuses a concurrency limit of zero, which would stall every conversion', () => {
    process.env[KEY] = '0';
    assert.strictEqual(envCount(KEY, 2, 1), 1);
    process.env[KEY] = '-4';
    assert.strictEqual(envCount(KEY, 2, 1), 1);
  });

  it('allows zero where it is meaningful, such as queueing nothing at all', () => {
    process.env[KEY] = '0';
    assert.strictEqual(envCount(KEY, 4, 0), 0);
  });

});

describe('envInt', () => {
  it('falls back when unset or non-numeric', () => {
    assert.strictEqual(envInt(KEY, 7), 7);
    process.env[KEY] = 'lots';
    assert.strictEqual(envInt(KEY, 7), 7);
  });
});
