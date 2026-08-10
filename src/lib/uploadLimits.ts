import type { ExtractedFile } from "./github";

// These two must stay in sync with the server's express.json() body limit
// (server.ts). Base64 encoding adds ~33% overhead, and the JSON wrapper
// (keys, quotes, commas) adds a bit more, so the server's raw byte limit
// needs meaningful headroom above MAX_TOTAL_UPLOAD_BYTES.
//   MAX_TOTAL_UPLOAD_BYTES = 50MB of original file bytes
//   -> ~66MB base64 -> server limit is set to 75mb for safety margin.
export const MAX_TOTAL_UPLOAD_BYTES = 50 * 1024 * 1024; // 50MB
// GitHub's Git Data API rejects blobs over 100MB; stay comfortably under it.
export const MAX_SINGLE_FILE_BYTES = 95 * 1024 * 1024; // 95MB

export interface SizeCheckResult {
  ok: boolean;
  error?: string;
}

const formatMB = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)}MB`;

/** Estimates original byte size from a base64 string's length, without decoding it. */
export const estimateBytesFromBase64 = (base64: string): number => {
  const len = base64.length;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((len * 3) / 4) - padding);
};

/**
 * Checks a fully-extracted file list against both the per-file and total
 * upload size limits, returning a clear, actionable error instead of letting
 * the browser hang/crash or the server reject with an opaque 413.
 */
export const checkUploadSize = (files: ExtractedFile[]): SizeCheckResult => {
  let total = 0;
  for (const file of files) {
    const size = estimateBytesFromBase64(file.content);
    if (size > MAX_SINGLE_FILE_BYTES) {
      return {
        ok: false,
        error: `"${file.path}" is ${formatMB(size)}, which is over GitHub's ${formatMB(MAX_SINGLE_FILE_BYTES)} per-file limit. Remove it from the ZIP and try again.`,
      };
    }
    total += size;
    if (total > MAX_TOTAL_UPLOAD_BYTES) {
      return {
        ok: false,
        error: `This ZIP is larger than the ${formatMB(MAX_TOTAL_UPLOAD_BYTES)} total upload limit. Try splitting it into smaller pushes or removing large/unnecessary files (e.g. node_modules, build output).`,
      };
    }
  }
  return { ok: true };
};
