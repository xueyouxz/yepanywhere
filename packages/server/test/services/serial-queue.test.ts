import { describe, expect, it } from "vitest";
import { SerialQueue } from "../../src/services/voice/serialQueue.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SerialQueue", () => {
  it("runs operations one at a time, never overlapping", async () => {
    const queue = new SerialQueue();
    const gate = deferred<void>();
    let firstRunning = false;
    let secondStarted = false;

    const first = queue.run(async () => {
      firstRunning = true;
      await gate.promise;
      firstRunning = false;
      return "a";
    });
    const second = queue.run(async () => {
      // Must not start until the first has finished.
      expect(firstRunning).toBe(false);
      secondStarted = true;
      return "b";
    });

    // While the first is parked on the gate, the second has not begun.
    await Promise.resolve();
    expect(secondStarted).toBe(false);

    gate.resolve();
    expect(await first).toBe("a");
    expect(await second).toBe("b");
    expect(secondStarted).toBe(true);
  });

  it("preserves FIFO order", async () => {
    const queue = new SerialQueue();
    const order: number[] = [];
    const tasks = [1, 2, 3].map((n) =>
      queue.run(async () => {
        order.push(n);
      }),
    );
    await Promise.all(tasks);
    expect(order).toEqual([1, 2, 3]);
  });

  it("isolates failures: a rejecting op does not break the chain", async () => {
    const queue = new SerialQueue();
    const failing = queue.run(async () => {
      throw new Error("boom");
    });
    const after = queue.run(async () => "ok");

    await expect(failing).rejects.toThrow("boom");
    expect(await after).toBe("ok");
  });
});
