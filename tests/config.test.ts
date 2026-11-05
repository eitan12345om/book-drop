import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { envChoice } from '../src/config.js';

describe('envChoice', () => {
  afterEach(() => {
    delete process.env.TEST_CHOICE;
  });

  it('reads one of the allowed values, ignoring case and surrounding space', () => {
    process.env.TEST_CHOICE = ' KindleGen ';
    assert.strictEqual(
      envChoice('TEST_CHOICE', ['kindling', 'kindlegen'], 'kindling'),
      'kindlegen'
    );
  });

  it('falls back when the variable is unset or not one of the allowed values', () => {
    assert.strictEqual(envChoice('TEST_CHOICE', ['kindling', 'kindlegen'], 'kindling'), 'kindling');
    process.env.TEST_CHOICE = 'kindlegenn';
    assert.strictEqual(envChoice('TEST_CHOICE', ['kindling', 'kindlegen'], 'kindling'), 'kindling');
  });
});
