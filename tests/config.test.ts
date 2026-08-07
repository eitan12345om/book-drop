import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
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
