import { describe, it, expect, vi } from "vitest";
import { LimiterPool } from "../src/netbird/limiterPool.js";

describe("LimiterPool.get", () => {
  it("returns the same limiter instance for the same token", () => {
    const pool = new LimiterPool(120);
    expect(pool.get("tenant-token")).toBe(pool.get("tenant-token"));
  });

  it("returns isolated limiter instances for different tokens", () => {
    const pool = new LimiterPool(120);
    expect(pool.get("tenant-a")).not.toBe(pool.get("tenant-b"));
  });

  it("keeps per-tenant budgets isolated: one tenant's exhausted window does not block another", async () => {
    const pool = new LimiterPool(1);
    vi.useFakeTimers();
    try {
      const a = pool.get("tenant-a");
      const b = pool.get("tenant-b");

      await a.acquire(); // exhausts tenant-a's single slot

      // tenant-b has its own budget and must resolve immediately.
      let bResolved = false;
      const bAcquire = b.acquire().then(() => {
        bResolved = true;
      });
      await Promise.resolve();
      expect(bResolved).toBe(true);
      await bAcquire;
    } finally {
      vi.useRealTimers();
    }
  });

  it("makes over-budget acquires wait for the window to slide, then evicts and admits", async () => {
    const pool = new LimiterPool(2);
    vi.useFakeTimers();
    try {
      const limiter = pool.get("tenant-a");

      // Fill the 2/window budget at t=0.
      await limiter.acquire();
      await limiter.acquire();

      // The 3rd acquire must block until the window slides.
      let admitted = false;
      const third = limiter.acquire().then(() => {
        admitted = true;
      });

      // Flush microtasks; still blocked short of the window.
      await Promise.resolve();
      expect(admitted).toBe(false);

      await vi.advanceTimersByTimeAsync(59_000);
      expect(admitted).toBe(false);

      // Past the 60s window (+1ms slack): oldest timestamps evict, slot frees.
      await vi.advanceTimersByTimeAsync(1_001);
      await third;
      expect(admitted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
