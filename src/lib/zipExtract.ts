// The ZIP-reading logic itself, with no knowledge of threads. Used by
// workers/extract.worker.ts (normal path) and by extractZip in github.ts
// (fallback when Web Workers are unavailable). Only types are imported from
// jszip, so the caller decides how the library is loaded.
import type JSZip from "jszip";
import { MAX_TOTAL_UPLOAD_BYTES, MAX_SINGLE_FILE_BYTES } from "./uploadLimits";
import { shouldSkipUploadPath } from "./uploadPaths";

const formatMB = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)}MB`;

// JSZip documents the file entry's internalStream API. Its type declaration
// currently includes the stream helper but omits that method on file entries.
type ZipFileEntry = JSZip.JSZipObject & {
  internalStream(type: "uint8array"): JSZip.JSZipStreamHelper<Uint8Array>;
};

function readZipFile(entry: JSZip.JSZipObject, path: string, bytesSoFar: number) {
  return new Promise<{ base64: string; bytes: number }>((resolve, reject) => {
    const stream = (entry as ZipFileEntry).internalStream("uint8array");
    let bytes = 0;
    let exceededLimit = false;
    const encoded: string[] = [];
    let tail = "";

    stream.on("data", (chunk) => {
      if (exceededLimit) return;
      bytes += chunk.length;
      if (bytes > MAX_SINGLE_FILE_BYTES || bytesSoFar + bytes > MAX_TOTAL_UPLOAD_BYTES) {
        exceededLimit = true;
        stream.pause();
        encoded.length = 0;
        reject(new Error(bytes > MAX_SINGLE_FILE_BYTES
          ? `"${path}" exceeds the ${formatMB(MAX_SINGLE_FILE_BYTES)} per-file limit. Remove it from the ZIP and try again.`
          : `This ZIP is larger than the ${formatMB(MAX_TOTAL_UPLOAD_BYTES)} total upload limit. Try splitting it into smaller pushes.`));
        return;
      }

      // Encode complete groups of three bytes. Carry any remainder to the next
      // chunk so Base64 padding is written only once, at the end of the file.
      const maxSlice = 16 * 1024;
      for (let offset = 0; offset < chunk.length; offset += maxSlice) {
        const text = tail + String.fromCharCode(...chunk.subarray(offset, offset + maxSlice));
        const boundary = text.length - text.length % 3;
        encoded.push(btoa(text.slice(0, boundary)));
        tail = text.slice(boundary);
      }
    }).on("error", reject).on("end", () => {
      if (!exceededLimit) {
        encoded.push(btoa(tail));
        resolve({ base64: encoded.join(""), bytes });
      }
    }).resume();
  });
}

export interface ZipExtractHooks {
  /** Called once per file, in archive order, after it passed the size checks. */
  onFile: (path: string, base64Content: string) => void;
  /** Give the event loop a turn between batches. Wanted on the main thread, pointless in a worker. */
  yieldBetweenBatches: boolean;
}

export async function extractZipEntries(
  JSZipClass: typeof JSZip,
  data: Parameters<typeof JSZip.loadAsync>[0],
  hooks: ZipExtractHooks
): Promise<void> {
  const zip = await JSZipClass.loadAsync(data);

  const entries: { path: string; entry: JSZip.JSZipObject }[] = [];
  zip.forEach((relativePath, zipEntry) => {
    if (zipEntry.dir || shouldSkipUploadPath(relativePath)) return;
    if (relativePath.includes("../") || relativePath.includes("..\\") || relativePath.startsWith("/")) return;
    entries.push({ path: relativePath, entry: zipEntry });
  });

  if (entries.length === 0) {
    throw new Error("This ZIP doesn't contain any files to upload.");
  }

  // Many ZIP exports wrap every file in one top-level folder (e.g. GitHub's
  // "Download ZIP", `zip -r project.zip myfolder/`) instead of zipping file
  // contents directly. If every entry shares the same first path segment,
  // strip it so files land at the repo root instead of one level deep.
  const firstSegment = (p: string) => p.split("/")[0];
  const rootFolder = firstSegment(entries[0].path);
  const allShareRoot =
    rootFolder !== "" &&
    entries.every((e) => e.path.includes("/") && firstSegment(e.path) === rootFolder);
  if (allShareRoot) {
    for (const e of entries) {
      e.path = e.path.slice(rootFolder.length + 1); // +1 to drop the "/"
    }
  }

  let totalBytes = 0;
  for (const [i, { path, entry }] of entries.entries()) {
    // One stream at a time lets every chunk enforce the remaining ZIP budget.
    const { base64, bytes } = await readZipFile(entry, path, totalBytes);
    totalBytes += bytes;
    hooks.onFile(path, base64);

    if (hooks.yieldBetweenBatches && (i + 1) % 6 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}
