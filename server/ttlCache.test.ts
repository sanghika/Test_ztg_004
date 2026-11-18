import { describe, it, expect, vi } from "vitest";
import { TtlCache } from "./ttlCache";

const clock = () => {
  let t = 0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

describe("TtlCache", () => {
  it("loads once and serves the cached value until the TTL passes", async () => {
    const c = clock();
    const cache = new TtlCache<number>(1000, 10, c.now);
    const loader = vi.fn(async () => 42);
    expect(await cache.getOrLoad("k", loader)).toBe(42);
    c.advance(999);
    expect(await cache.getOrLoad("k", loader)).toBe(42);
    expect(loader).toHaveBeenCalledTimes(1);
    c.advance(2);
    await cache.getOrLoad("k", loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("shares one load between concurrent callers", async () => {
    const cache = new TtlCache<string>(1000);
    let release!: (v: string) => void;
    const loader = vi.fn(() => new Promise<string>((res) => (release = res)));
    const a = cache.getOrLoad("k", loader);
    const b = cache.getOrLoad("k", loader);
    release("done");
    expect(await a).toBe("done");
    expect(await b).toBe("done");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("starts the TTL when the load finishes, not when it starts", async () => {
    const c = clock();
    const cache = new TtlCache<number>(1000, 10, c.now);
    let release!: (v: number) => void;
    const loader = vi.fn(() => new Promise<number>((res) => (release = res)));
    const first = cache.getOrLoad("k", loader);
    c.advance(5000); // a slow load
    release(1);
    await first;
    await cache.getOrLoad("k", loader);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("never keeps a failed load", async () => {
    const cache = new TtlCache<number>(1000);
    const loader = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(7);
    await expect(cache.getOrLoad("k", loader)).rejects.toThrow("boom");
    expect(await cache.getOrLoad("k", loader)).toBe(7);
  });

  it("invalidates by key prefix only", async () => {
    const cache = new TtlCache<number>(1000);
    await cache.getOrLoad("a:1", async () => 1);
    await cache.getOrLoad("a:2", async () => 2);
    await cache.getOrLoad("b:1", async () => 3);
    cache.invalidatePrefix("a:");
    expect(cache.size).toBe(1);
  });

  it("stays within its size cap, dropping the oldest entries", async () => {
    const cache = new TtlCache<number>(1000, 3);
    for (let i = 0; i < 10; i++) await cache.getOrLoad(`k${i}`, async () => i);
    expect(cache.size).toBeLessThanOrEqual(3);
    const loader = vi.fn(async () => 99);
    await cache.getOrLoad("k9", loader); // newest is still cached
    expect(loader).not.toHaveBeenCalled();
  });
});
