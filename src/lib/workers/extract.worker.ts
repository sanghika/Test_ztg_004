// Reads a ZIP off the main thread: JSZip's parsing and base64 encoding of every
// entry are the heavy part of "pick a ZIP". See extractZip in github.ts for the
// caller. Each file goes back as its own message as soon as it is ready, so the
// main thread never has to receive one huge message.
import "./setImmediateShim"; // must stay first: it has to run before jszip does
import JSZip from "jszip";
import { extractZipEntries } from "../zipExtract";

const scope = self as unknown as {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
};

scope.postMessage({ type: "ready" });

scope.onmessage = async (event: MessageEvent<{ file: Blob }>) => {
  try {
    await extractZipEntries(JSZip, event.data.file, {
      onFile: (path, content) => scope.postMessage({ type: "file", path, content }),
      yieldBetweenBatches: false, // nothing to keep responsive in a worker
    });
    scope.postMessage({ type: "done", result: null });
  } catch (err: any) {
    // The message is shown to the visitor as is (size limits, "not a ZIP", ...).
    scope.postMessage({ type: "error", message: err?.message || "Could not read this ZIP." });
  }
};
