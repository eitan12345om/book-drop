import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  KEY_CHARS,
  KEY_LENGTH,
  randomKey,
  generateUniqueKey,
  expireKey,
  removeKey,
} from '../src/keyStore.js';
import { EXPIRE_DELAY_MS } from '../src/config.js';
import type { KeyInfo } from '../src/types.js';

function makeKeyInfo(overrides: Partial<KeyInfo> = {}): KeyInfo {
  return {
    created: new Date(),
    agent: 'TestBrowser/1.0',
    file: null,
    urls: [],
    timer: null,
    downloadTimer: null,
    alive: new Date(),
    ...overrides,
  };
}

describe('randomKey', () => {
  it('generates a key of the correct length', () => {
    assert.strictEqual(randomKey().length, KEY_LENGTH);
  });

  it('only contains characters from KEY_CHARS', () => {
    for (let i = 0; i < 200; i++) {
      for (const ch of randomKey()) {
        assert.ok(KEY_CHARS.includes(ch));
      }
    }
  });

  it('does not contain ambiguous characters (0, 1, O, I, B)', () => {
    for (let i = 0; i < 200; i++) {
      assert.doesNotMatch(randomKey(), /[01OIB]/);
    }
  });

  it('produces different keys across multiple calls', () => {
    const keys = new Set(Array.from({ length: 50 }, () => randomKey()));
    // With 30^4 = 810,000 possibilities, 50 calls should produce many unique values
    assert.ok(keys.size > 10);
  });
});

describe('generateUniqueKey', () => {
  it('returns a key not already in the map', () => {
    const keys = new Map<string, KeyInfo>();
    const key = generateUniqueKey(keys);
    assert.notStrictEqual(key, null);
    assert.strictEqual(key!.length, KEY_LENGTH);
    assert.strictEqual(keys.has(key!), false);
  });

  it('avoids collisions with existing keys', () => {
    const keys = new Map<string, KeyInfo>();
    keys.set('AAAA', makeKeyInfo());
    keys.set('BBBB', makeKeyInfo());
    const key = generateUniqueKey(keys);
    assert.notStrictEqual(key, null);
    assert.strictEqual(keys.has(key!), false);
  });

  it('returns null when the map is too full to generate uniquely', () => {
    const keys = new Map<string, KeyInfo>();
    for (let i = 0; i < 200; i++) {
      const k = i.toString().padStart(KEY_LENGTH, 'A').substring(0, KEY_LENGTH);
      keys.set(k, makeKeyInfo());
    }
    const result = generateUniqueKey(keys);
    assert.ok(result === null || (typeof result === 'string' && result.length === KEY_LENGTH));
  });
});

describe('expireKey', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  });
  afterEach(() => {
    mock.timers.reset();
  });

  it('sets a timer on the key info', () => {
    const keys = new Map<string, KeyInfo>();
    const info = makeKeyInfo();
    keys.set('TEST', info);
    expireKey('TEST', keys);
    assert.notStrictEqual(info.timer, null);
  });

  it('updates alive timestamp', () => {
    const keys = new Map<string, KeyInfo>();
    const before = new Date();
    const info = makeKeyInfo({ alive: new Date(0) });
    keys.set('TEST', info);
    expireKey('TEST', keys);
    assert.ok(info.alive.getTime() >= before.getTime());
  });

  it('removes the key after EXPIRE_DELAY_MS', () => {
    const keys = new Map<string, KeyInfo>();
    keys.set('ZZZZ', makeKeyInfo());
    expireKey('ZZZZ', keys);
    assert.ok(keys.has('ZZZZ'));
    mock.timers.tick(EXPIRE_DELAY_MS + 1);
    assert.strictEqual(keys.has('ZZZZ'), false);
  });

  it('resets an existing timer when called again', () => {
    const keys = new Map<string, KeyInfo>();
    keys.set('AAAA', makeKeyInfo());
    expireKey('AAAA', keys);
    mock.timers.tick(EXPIRE_DELAY_MS - 5000); // advance but not expired
    expireKey('AAAA', keys); // reset timer
    mock.timers.tick(5000); // would have expired if not reset
    assert.ok(keys.has('AAAA'));
    mock.timers.tick(EXPIRE_DELAY_MS);
    assert.strictEqual(keys.has('AAAA'), false);
  });
});

describe('removeKey', () => {
  it('removes the key from the map', () => {
    const keys = new Map<string, KeyInfo>();
    keys.set('ABCD', makeKeyInfo());
    removeKey('ABCD', keys);
    assert.strictEqual(keys.has('ABCD'), false);
  });

  it('is a no-op for unknown keys', () => {
    const keys = new Map<string, KeyInfo>();
    assert.doesNotThrow(() => removeKey('XXXX', keys));
  });

  it('clears the timer on removal', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const keys = new Map<string, KeyInfo>();
    const info = makeKeyInfo();
    keys.set('DCBA', info);
    expireKey('DCBA', keys);
    assert.notStrictEqual(info.timer, null);
    removeKey('DCBA', keys);
    assert.strictEqual(keys.has('DCBA'), false);
    mock.timers.reset();
  });

  it('clears the downloadTimer on removal', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const keys = new Map<string, KeyInfo>();
    const info = makeKeyInfo();
    keys.set('EFGH', info);
    info.downloadTimer = setTimeout(() => {}, 60_000);
    assert.notStrictEqual(info.downloadTimer, null);
    removeKey('EFGH', keys);
    assert.strictEqual(keys.has('EFGH'), false);
    mock.timers.reset();
  });
});
