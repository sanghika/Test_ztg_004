// Reads a ZIP off the main thread: JSZip's parsing and base64 encoding of every
// entry are the heavy part of "pick a ZIP". See extractZip in github.ts for the
// caller. Group small files to reduce message overhead. Send large files individually.
import "./setImmediateShim"; // must stay first: it has to run before jszip does
import JSZip from "jszip";
import type { ExtractedFile } from "../github";
import { extractZipEntries } from "../zipExtract";

const scope = self as unknown as {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
};

scope.postMessage({ type: "ready" });

scope.onmessage = async (event: MessageEvent<{ file: Blob }>) => {
  let files: ExtractedFile[] = [];
  let chars = 0;
  const maxChars = 256 * 1024;
  const flush = () => {
    if (!files.length) return;
    scope.postMessage({ type: "files", files });
    files = [];
    chars = 0;
  };

  try {
    await extractZipEntries(JSZip, event.data.file, {
      onFile: (file) => {
        const size = file.path.length + file.content.length;
        if (chars + size > maxChars) flush();
        files.push(file);
        chars += size;
        if (files.length === 32 || chars >= maxChars) flush();
      },
      yieldBetweenBatches: false, // nothing to keep responsive in a worker
    });
    flush();
    scope.postMessage({ type: "done", result: null });
  } catch (err: any) {
    // The message is shown to the visitor as is (size limits, "not a ZIP", ...).
    scope.postMessage({ type: "error", message: err?.message || "Could not read this ZIP." });
  }
};
