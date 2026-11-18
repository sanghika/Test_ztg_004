// Imported first by extract.worker.ts, before jszip is evaluated.
//
// JSZip schedules each step of its async work with setImmediate and ships a
// polyfill for browsers. That polyfill picks a strategy by looking for
// importScripts, which a *module* worker (what Vite serves in dev) does not
// have, so it can choose a postMessage trick that does not work in a worker.
// Defining setImmediate up front makes it skip the polyfill. This uses a
// MessageChannel rather than setTimeout(0) because setTimeout is clamped to
// about 4ms after a few nested calls, and JSZip makes thousands of them on a
// large file.
const scope = self as unknown as {
  setImmediate?: (fn: (...args: any[]) => void, ...args: any[]) => number;
  clearImmediate?: (id: number) => void;
};

if (typeof scope.setImmediate !== "function") {
  const pending = new Map<number, () => void>();
  let nextId = 1;
  const channel = new MessageChannel();
  channel.port1.onmessage = (event: MessageEvent) => {
    const fn = pending.get(event.data as number);
    if (fn) {
      pending.delete(event.data as number);
      fn();
    }
  };
  scope.setImmediate = (fn, ...args) => {
    const id = nextId++;
    pending.set(id, () => fn(...args));
    channel.port2.postMessage(id);
    return id;
  };
  scope.clearImmediate = (id) => {
    pending.delete(id);
  };
}

export {};
