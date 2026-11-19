// A tiny wrapper for "run one job in a Web Worker and get the answer back".
// Workers here are one-shot: created for a job and terminated when it ends, so
// whatever the job held in memory (decoded files, JSZip's buffers) is released
// at once instead of lingering in a long-lived worker.
//
// Message protocol, worker -> page:
//   { type: "ready" }                    sent as soon as the script has loaded
//   { type: "progress"|"file"|..., ... } anything else goes to onMessage
//   { type: "done", result }             resolves the job with `result`
//   { type: "error", message }           rejects the job with Error(message)

/** The worker could not be created or never started. The job can safely be redone another way. */
export class WorkerUnavailableError extends Error {}

export const workersSupported = (): boolean => typeof Worker !== "undefined";

export function runWorkerJob<T>(
  worker: Worker,
  message: unknown,
  onMessage?: (message: any) => void,
  signal?: AbortSignal
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let started = false;
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    };
    const abort = () => {
      finish();
      reject(signal?.reason);
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event: MessageEvent) => {
      started = true;
      const m = event.data;
      if (m?.type === "ready") return;
      if (m?.type === "done") {
        finish();
        resolve(m.result as T);
      } else if (m?.type === "error") {
        finish();
        reject(new Error(m.message));
      } else {
        onMessage?.(m);
      }
    };
    // Fired when the script fails to load or throws outside our try/catch.
    // Before the first message that means "this browser cannot run it", so the
    // caller may fall back; after it, the worker died mid-job.
    worker.onerror = (event: ErrorEvent) => {
      event.preventDefault?.();
      finish();
      reject(
        started
          ? new Error("The background task stopped unexpectedly. Try again, or use a smaller file.")
          : new WorkerUnavailableError(event.message || "The worker could not start.")
      );
    };
    worker.onmessageerror = () => {
      finish();
      reject(new Error("The background task returned data this browser could not read."));
    };
    try {
      worker.postMessage(message);
    } catch (err) {
      finish();
      reject(err);
    }
  });
}

// --- Optional pre-spawned worker ------------------------------------------ //
// Starting a worker means downloading and evaluating its script (for the ZIP
// worker that includes JSZip). prewarmWorker does that when the visitor opens the
// ZIP picker or drags a ZIP over the drop zone, and takeWorker hands the ready worker to the first job.
const warmed = new Map<string, { worker: Worker; timer: ReturnType<typeof setTimeout> }>();
const WARM_WORKER_TTL_MS = 2 * 60 * 1000;

export function prewarmWorker(key: string, create: () => Worker): void {
  if (!workersSupported() || warmed.has(key)) return;
  try {
    const worker = create();
    // Only acts while the worker is still waiting here, so a worker that a job
    // has taken in the meantime is never terminated by this.
    const drop = () => {
      const entry = warmed.get(key);
      if (!entry || entry.worker !== worker) return;
      clearTimeout(entry.timer);
      warmed.delete(key);
      worker.terminate();
    };
    // A worker that fails while idle must not be handed to a job later.
    worker.onerror = drop;
    // Not used soon: free it. A later job simply starts a fresh one.
    warmed.set(key, { worker, timer: setTimeout(drop, WARM_WORKER_TTL_MS) });
  } catch {
    // Not supported here; the job will fall back or start its own worker.
  }
}

export function takeWorker(key: string, create: () => Worker): Worker {
  const entry = warmed.get(key);
  if (entry) {
    clearTimeout(entry.timer);
    warmed.delete(key);
    return entry.worker;
  }
  return create();
}
