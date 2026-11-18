// A small in-memory cache for async loaders: entries expire after `ttlMs`,
// concurrent requests for the same key share one load, a failed load is never
// kept, and the cache is capped so it cannot grow without bound.

type Entry<V> = { promise: Promise<V>; expires: number };

export class TtlCache<V> {
  private entries = new Map<string, Entry<V>>();

  constructor(
    private ttlMs: number,
    private maxEntries = 500,
    private now: () => number = () => Date.now()
  ) {}

  get size(): number {
    return this.entries.size;
  }

  /** The cached value for `key`, or the result of `loader()`, which is then cached. */
  getOrLoad(key: string, loader: () => Promise<V>): Promise<V> {
    const hit = this.entries.get(key);
    if (hit && hit.expires > this.now()) return hit.promise;

    this.prune();
    // The clock only starts when the load has finished, so a slow load is not
    // born already stale. Until then the entry is shared by everyone who asks.
    const entry: Entry<V> = { promise: undefined as unknown as Promise<V>, expires: Infinity };
    entry.promise = loader().then(
      (value) => {
        entry.expires = this.now() + this.ttlMs;
        return value;
      },
      (error) => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw error;
      }
    );
    this.entries.set(key, entry);
    return entry.promise;
  }

  /** Drops every entry whose key starts with `prefix`. */
  invalidatePrefix(prefix: string): void {
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  // Expired entries first, then the oldest, until there is room for one more.
  private prune(): void {
    const t = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expires <= t) this.entries.delete(key);
    }
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
