/** Thrown when the queue is already full, so the caller is rejected instead of joining it. */
export class QueueFullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueueFullError';
  }
}

/**
 * Runs at most `limit` tasks at once, queueing up to `maxQueued` more, each for no
 * longer than `maxWaitMs`.
 *
 * The queue is bounded twice over because waiting forever is its own failure: work that
 * finishes after the user has given up costs the same as work that succeeds. The depth
 * limit sheds load immediately when the queue is clearly hopeless, and the wait limit
 * caps how long anyone admitted to it can be left hanging.
 */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly limit: number,
    private readonly maxQueued: number,
    private readonly maxWaitMs: number
  ) {}

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.waiting.length;
  }

  /**
   * Waits for a slot, then runs the task. The task receives how long it spent queued,
   * which is worth logging: a queue that is never empty is the signal to add capacity.
   */
  async run<T>(task: (queuedMs: number) => Promise<T>): Promise<T> {
    const queuedAt = Date.now();
    if (this.active < this.limit) {
      this.active++;
    } else {
      if (this.waiting.length >= this.maxQueued) {
        throw new QueueFullError(
          `all ${this.limit} slots busy with ${this.waiting.length} already waiting`
        );
      }
      await new Promise<void>((resolve, reject) => {
        const wake = (): void => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          const index = this.waiting.indexOf(wake);
          if (index !== -1) {
            this.waiting.splice(index, 1);
          }
          reject(new QueueFullError(`waited ${this.maxWaitMs}ms without a slot coming free`));
        }, this.maxWaitMs);
        this.waiting.push(wake);
      });
    }
    try {
      return await task(Date.now() - queuedAt);
    } finally {
      const next = this.waiting.shift();
      if (next) {
        next();
      } else {
        this.active--;
      }
    }
  }
}
