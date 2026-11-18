import { describe, it, expect } from "vitest";
import { prewarmWorker, runWorkerJob, takeWorker, WorkerUnavailableError } from "./workerJob";

// Just enough of a Worker to drive runWorkerJob by hand.
class FakeWorker {
  onmessage: ((e: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  onmessageerror: ((e: any) => void) | null = null;
  terminated = false;
  posted: unknown[] = [];
  postMessage(message: unknown) { this.posted.push(message); }
  terminate() { this.terminated = true; }
  emit(data: unknown) { this.onmessage?.({ data }); }
  fail(message: string) { this.onerror?.({ message, preventDefault() {} }); }
}
const asWorker = (w: FakeWorker) => w as unknown as Worker;

describe("runWorkerJob", () => {
  it("sends the job, resolves with the result of 'done', and terminates the worker", async () => {
    const w = new FakeWorker();
    const job = runWorkerJob<number>(asWorker(w), { hello: 1 });
    expect(w.posted).toEqual([{ hello: 1 }]);
    w.emit({ type: "ready" });
    w.emit({ type: "done", result: 42 });
    expect(await job).toBe(42);
    expect(w.terminated).toBe(true);
  });

  it("passes other messages to onMessage but not 'ready'", async () => {
    const w = new FakeWorker();
    const seen: unknown[] = [];
    const job = runWorkerJob<null>(asWorker(w), {}, (m) => seen.push(m));
    w.emit({ type: "ready" });
    w.emit({ type: "file", path: "a" });
    w.emit({ type: "done", result: null });
    await job;
    expect(seen).toEqual([{ type: "file", path: "a" }]);
  });

  it("rejects with the worker's message for an 'error' message, and that is not 'unavailable'", async () => {
    const w = new FakeWorker();
    const job = runWorkerJob(asWorker(w), {});
    w.emit({ type: "error", message: "This ZIP doesn't contain any files to upload." });
    let caught: any;
    try { await job; } catch (e) { caught = e; }
    expect(caught.message).toBe("This ZIP doesn't contain any files to upload.");
    expect(caught instanceof WorkerUnavailableError).toBe(false);
    expect(w.terminated).toBe(true);
  });

  it("reports WorkerUnavailableError when the worker fails before it has sent anything", async () => {
    const w = new FakeWorker();
    const job = runWorkerJob(asWorker(w), {});
    w.fail("Failed to load script");
    let caught: any;
    try { await job; } catch (e) { caught = e; }
    expect(caught instanceof WorkerUnavailableError).toBe(true);
  });

  it("reports a plain error, not 'unavailable', when the worker dies after it started", async () => {
    const w = new FakeWorker();
    const job = runWorkerJob(asWorker(w), {});
    w.emit({ type: "file", path: "a" });
    w.fail("out of memory");
    let caught: any;
    try { await job; } catch (e) { caught = e; }
    expect(caught instanceof WorkerUnavailableError).toBe(false);
    expect(caught instanceof Error).toBe(true);
  });
});

describe("prewarmWorker / takeWorker", () => {
  it("hands the pre-spawned worker to the first job only", () => {
    const g = globalThis as any;
    const hadWorker = "Worker" in g;
    const original = g.Worker;
    g.Worker = class {};
    try {
      let created = 0;
      const create = () => { created++; return new FakeWorker() as unknown as Worker; };
      prewarmWorker("test-key", create);
      expect(created).toBe(1);
      const first = takeWorker("test-key", create);
      expect(created).toBe(1); // reused the warm one
      const second = takeWorker("test-key", create);
      expect(created).toBe(2); // none left, so a new one
      expect(second === first).toBe(false);
    } finally {
      if (hadWorker) g.Worker = original; else delete g.Worker;
    }
  });
});
