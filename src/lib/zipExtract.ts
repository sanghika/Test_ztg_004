// The ZIP-reading logic itself, with no knowledge of threads. Used by
// workers/extract.worker.ts (normal path) and by extractZip in github.ts
// (fallback when Web Workers are unavailable). Only types are imported from
// jszip, so the caller decides how the library is loaded.
import type JSZip from "jszip";
import { estimateBytesFromBase64, MAX_TOTAL_UPLOAD_BYTES, MAX_SINGLE_FILE_BYTES } from "./uploadLimits";

const formatMB = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)}MB`;

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
    if (!zipEntry.dir && !relativePath.includes("__MACOSX") && !relativePath.startsWith(".DS_Store")) {
      if (relativePath.includes("../") || relativePath.includes("..\\") || relativePath.startsWith("/")) {
        return;
      }
      entries.push({ path: relativePath, entry: zipEntry });
    }
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
  const MAX_CONCURRENT_EXTRACT = 6;
  for (let i = 0; i < entries.length; i += MAX_CONCURRENT_EXTRACT) {
    const batch = entries.slice(i, i + MAX_CONCURRENT_EXTRACT);
    const batchResults = await Promise.all(
      batch.map(async (item) => ({ item, base64Content: await item.entry.async("base64") }))
    );

    // Applied in original order (not completion order) so size-limit errors
    // are always reported deterministically.
    for (const { item, base64Content } of batchResults) {
      // Fail fast instead of extracting the entire (possibly huge) ZIP into
      // memory first — a very large archive can otherwise hang or crash the tab.
      const fileBytes = estimateBytesFromBase64(base64Content);
      if (fileBytes > MAX_SINGLE_FILE_BYTES) {
        throw new Error(
          `"${item.path}" is ${formatMB(fileBytes)}, which is over GitHub's ${formatMB(MAX_SINGLE_FILE_BYTES)} per-file limit. Remove it from the ZIP and try again.`
        );
      }
      totalBytes += fileBytes;
      if (totalBytes > MAX_TOTAL_UPLOAD_BYTES) {
        throw new Error(
          `This ZIP is larger than the ${formatMB(MAX_TOTAL_UPLOAD_BYTES)} total upload limit. Try splitting it into smaller pushes or removing large/unnecessary files (e.g. node_modules, build output).`
        );
      }

      hooks.onFile(item.path, base64Content);
    }

    // On the main thread, yield between batches (rather than every 10 files)
    // so the progress UI keeps painting without giving up the concurrency win.
    if (hooks.yieldBetweenBatches) await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
