import { describe, it, expect } from "vitest";
import { ProcessPool } from "./runner.js";

describe("ProcessPool", () => {
  it("allows acquire up to maxConcurrent", async () => {
    const pool = new ProcessPool(2, 5);
    await pool.acquire(); // slot 1
    await pool.acquire(); // slot 2
    // Should not hang — both acquired synchronously
    pool.release();
    pool.release();
  });

  it("queues when at capacity and releases on next release", async () => {
    const pool = new ProcessPool(1, 5, 5000);
    await pool.acquire(); // fills the single slot

    let resolved = false;
    const pending = pool.acquire().then(() => { resolved = true; });

    // Not yet resolved
    expect(resolved).toBe(false);

    // Release the slot
    pool.release();
    await pending;
    expect(resolved).toBe(true);
    pool.release();
  });

  it("throws when queue overflows", async () => {
    const pool = new ProcessPool(1, 1, 5000);
    await pool.acquire(); // fills slot

    // Queue one (ok)
    const p1 = pool.acquire();

    // Queue second should overflow (maxQueueDepth=1)
    await expect(pool.acquire()).rejects.toThrow("Service at capacity");

    pool.release(); // release for p1
    await p1;
    pool.release();
  });

  it("times out queued requests", async () => {
    const pool = new ProcessPool(1, 5, 50); // 50ms timeout
    await pool.acquire();

    await expect(pool.acquire()).rejects.toThrow("Queue timeout");
    pool.release();
  });
});
