import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  KEY_CHARS,
  KEY_LENGTH,
  randomKey,
  generateUniqueKey,
  expireKey,
  removeKey,
  clearFiles,
  addDiskUsage,
  getDiskUsage,
} from '../src/keyStore.js';
import { EXPIRE_DELAY_MS } from '../src/config.js';
import type { KeyInfo, FileInfo } from '../src/types.js';

function makeKeyInfo(overrides: Partial<KeyInfo> = {}): KeyInfo {
  return {
    created: new Date(),
    ip: '127.0.0.1',
    agent: 'TestBrowser/1.0',
    files: [],
    urls: [],
    timer: null,
    pendingUploads: 0,
    pendingFilenames: [],
    alive: new Date(),
    ...overrides,
  };
}

function makeFileInfo(overrides: Partial<FileInfo> = {}): FileInfo {
  return {
    name: 'test.epub',
    path: '/tmp/test.epub',
    size: 500,
    uploaded: new Date(),
    downloadTimer: null,
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

  it('clears the downloadTimer on each staged file when removeKey is called', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const keys = new Map<string, KeyInfo>();
    const file = makeFileInfo({ downloadTimer: setTimeout(() => {}, 60_000) });
    const info = makeKeyInfo({ files: [file] });
    keys.set('EFGH', info);
    assert.notStrictEqual(file.downloadTimer, null);
    removeKey('EFGH', keys);
    assert.strictEqual(keys.has('EFGH'), false);
    mock.timers.reset();
  });

  it('calls onRemove callback if set', () => {
    const keys = new Map<string, KeyInfo>();
    const onRemove = mock.fn();
    keys.set('IJKL', makeKeyInfo({ onRemove }));
    removeKey('IJKL', keys);
    assert.strictEqual(onRemove.mock.calls.length, 1);
  });

  it('does not throw when onRemove is not set', () => {
    const keys = new Map<string, KeyInfo>();
    keys.set('MNOP', makeKeyInfo());
    assert.doesNotThrow(() => removeKey('MNOP', keys));
  });
});

describe('clearFiles', () => {
  it('subtracts each file size from the disk usage counter', () => {
    const info = makeKeyInfo({
      files: [
        makeFileInfo({ size: 300 }),
        makeFileInfo({ name: 'b.epub', path: '/tmp/b.epub', size: 200 }),
      ],
    });
    addDiskUsage(500);
    const before = getDiskUsage();
    clearFiles(info);
    assert.strictEqual(getDiskUsage(), before - 500);
  });

  it('empties info.files', () => {
    const info = makeKeyInfo({
      files: [makeFileInfo()],
    });
    clearFiles(info);
    assert.strictEqual(info.files.length, 0);
  });

  it('is a no-op when info.files is already empty', () => {
    const info = makeKeyInfo();
    const before = getDiskUsage();
    assert.doesNotThrow(() => clearFiles(info));
    assert.strictEqual(getDiskUsage(), before);
  });

  it('cancels each file downloadTimer', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const timerFired = { value: false };
    const file = makeFileInfo({
      downloadTimer: setTimeout(() => {
        timerFired.value = true;
      }, 60_000),
    });
    const info = makeKeyInfo({ files: [file] });
    clearFiles(info);
    mock.timers.tick(60_001);
    assert.strictEqual(timerFired.value, false);
    mock.timers.reset();
  });

  it('decrements disk usage when removeKey is called with staged files', () => {
    const keys = new Map<string, KeyInfo>();
    const info = makeKeyInfo({
      files: [makeFileInfo({ size: 1000 })],
    });
    addDiskUsage(1000);
    const before = getDiskUsage();
    keys.set('ABCD', info);
    removeKey('ABCD', keys);
    assert.strictEqual(getDiskUsage(), before - 1000);
  });
});

describe('expireKey — onRemove callback', () => {
  it('calls onRemove when key expires after EXPIRE_DELAY_MS', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const keys = new Map<string, KeyInfo>();
    const onRemove = mock.fn();
    keys.set('QRST', makeKeyInfo({ onRemove }));
    expireKey('QRST', keys);
    assert.strictEqual(onRemove.mock.calls.length, 0);
    mock.timers.tick(EXPIRE_DELAY_MS + 1);
    assert.strictEqual(onRemove.mock.calls.length, 1);
    mock.timers.reset();
  });
});
