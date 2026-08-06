import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Semaphore, QueueFullError } from '../src/semaphore.js';

/** A task that resolves only when told to, so overlap can be observed rather than timed. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('Semaphore', () => {
  it('runs up to the limit at once and makes the rest wait', async () => {
    const sem = new Semaphore(2, 10, 5_000);
    const gates = [deferred(), deferred(), deferred()];
    const started: number[] = [];

    const runs = gates.map((gate, i) =>
      sem.run(async () => {
        started.push(i);
        await gate.promise;
      })
    );

    await new Promise(setImmediate);
    assert.deepStrictEqual(started, [0, 1], 'third task should not have started');
    assert.strictEqual(sem.activeCount, 2);
    assert.strictEqual(sem.queuedCount, 1);

    gates[0].resolve();
    await runs[0];
    await new Promise(setImmediate);
    assert.deepStrictEqual(started, [0, 1, 2], 'third task should start when a slot frees');

    gates[1].resolve();
    gates[2].resolve();
    await Promise.all(runs);
    assert.strictEqual(sem.activeCount, 0);
    assert.strictEqual(sem.queuedCount, 0);
  });

  it('rejects once the queue is full rather than queueing without limit', async () => {
    const sem = new Semaphore(1, 1, 5_000);
    const gate = deferred();
    const running = sem.run(async () => {
      await gate.promise;
    });
    const queued = sem.run(async () => {});

    await assert.rejects(() => sem.run(async () => {}), QueueFullError);

    gate.resolve();
    await Promise.all([running, queued]);
  });

  it('frees the slot when a task throws', async () => {
    const sem = new Semaphore(1, 1, 5_000);
    await assert.rejects(
      () =>
        sem.run(async () => {
          throw new Error('boom');
        }),
      /boom/
    );
    assert.strictEqual(sem.activeCount, 0);
    assert.strictEqual(await sem.run(async () => 'ok'), 'ok');
  });

  it('reports how long a task waited, so a saturated queue is visible in logs', async () => {
    const sem = new Semaphore(1, 1, 5_000);
    const gate = deferred();
    const first = sem.run(async () => {
      await gate.promise;
    });

    let queuedMs = -1;
    const second = sem.run(async (waited) => {
      queuedMs = waited;
    });

    setTimeout(() => gate.resolve(), 20);
    await Promise.all([first, second]);
    assert.ok(queuedMs >= 15, `expected a recorded wait, got ${queuedMs}ms`);
  });

  it('gives up waiting rather than leaving a caller queued indefinitely', async () => {
    const sem = new Semaphore(1, 5, 20);
    const gate = deferred();
    const running = sem.run(async () => {
      await gate.promise;
    });

    await assert.rejects(() => sem.run(async () => 'never runs'), QueueFullError);
    assert.strictEqual(sem.queuedCount, 0);

    gate.resolve();
    await running;
    assert.strictEqual(await sem.run(async () => 'ok'), 'ok');
  });

  it('does not exceed the limit when a slot is handed to a waiter', async () => {
    const sem = new Semaphore(2, 10, 5_000);
    let peak = 0;
    const gates = Array.from({ length: 6 }, () => deferred());

    const runs = gates.map((gate) =>
      sem.run(async () => {
        peak = Math.max(peak, sem.activeCount);
        await gate.promise;
      })
    );

    for (const gate of gates) {
      gate.resolve();
      await new Promise(setImmediate);
    }
    await Promise.all(runs);
    assert.strictEqual(peak, 2, `never more than 2 concurrent, saw ${peak}`);
  });
});
