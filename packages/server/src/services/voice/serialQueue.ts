/**
 * Runs async operations one at a time, in FIFO order. A request that arrives
 * while another is still running — e.g. a transcribe while the model is still
 * loading, or a model swap is in flight — waits its turn instead of being
 * rejected. The local STT backends are single-worker by design, so this turns
 * "backend is busy with another request" errors into queued waits: record
 * audio, block on the load, then transcribe.
 *
 * Failures are isolated: one operation rejecting does not break the chain for
 * the next, and the promise returned to each caller still reflects that
 * operation's own resolution or rejection.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(op: () => Promise<T>): Promise<T> {
    // Start `op` only after the previous operation settles (resolved OR
    // rejected), so operations never overlap.
    const result = this.tail.then(op, op);
    // The chain tail swallows outcomes so a rejection does not poison the queue.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
