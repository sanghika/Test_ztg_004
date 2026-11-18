import { describe, it, expect } from "vitest";
import { mapWithConcurrency } from "./pool";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("mapWithConcurrency", () => {
  it("returns results in input order, whatever order the calls finish in", async () => {
    const delays = [30, 5, 20, 1, 10];
    const out = await mapWithConcurrency(delays, 3, async (ms, i) => {
      await sleep(ms);
      return `item-${i}`;
    });
    expect(out).toEqual(["item-0", "item-1", "item-2", "item-3", "item-4"]);
  });

  it("never runs more than `limit` calls at once, and keeps the slots full", async () => {
    let running = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      running++;
      peak = Math.max(peak, running);
      await sleep(3);
      running--;
    });
    expect(peak).toBe(4);
  });

  it("starts the next item as soon as a slot frees up, instead of waiting for the whole group", async () => {
    const startedAt: Record<string, number> = {};
    const t0 = Date.now();
    // Two slots. "slow" occupies one for 120 ms; the five quick items should
    // flow through the other slot meanwhile. With fixed groups of two, "d"
    // would not start until "slow" was done.
    await mapWithConcurrency(["slow", "a", "b", "c", "d", "e"], 2, async (name) => {
      startedAt[name] = Date.now() - t0;
      await sleep(name === "slow" ? 120 : 10);
    });
    expect(startedAt.d).toBeLessThan(100);
    expect(startedAt.e).toBeLessThan(100);
  });

  it("stops starting new items after a failure and rejects with that error", async () => {
    const started: number[] = [];
    await expect(
      mapWithConcurrency(Array.from({ length: 10 }, (_, i) => i), 2, async (i) => {
        started.push(i);
        await sleep(5);
        if (i === 1) throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(started.length).toBeLessThan(10);
  });

  it("handles an empty list and a limit larger than the list", async () => {
    expect(await mapWithConcurrency([], 5, async () => 1)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 50, async (n) => n * 2)).toEqual([2, 4]);
  });
});
