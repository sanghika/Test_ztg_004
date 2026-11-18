import type { ExtractedFile } from "./github";
import { estimateBytesFromBase64 } from "./uploadLimits";
import { isBinaryPath, isExcludedPath, scanContent, type ScanOutcome } from "./secretScannerCore";
import { runWorkerJob, takeWorker, workersSupported } from "./workerJob";

export interface SanitizeReport {
  /** Dropped from the push entirely (.env, private keys, ...). */
  skippedFiles: string[];
  /** Had secrets replaced with [REDACTED-SECRET]. */
  redactedFiles: { path: string; matches: string[] }[];
  /** Pushed as they are because they are too large to scan (see MAX_SCAN_BYTES). */
  unscannedFiles: string[];
}

// What a scan can change about a file; "clean" and "binary" files are untouched
// and simply not mentioned.
type Finding = Exclude<ScanOutcome, { kind: "clean" } | { kind: "binary" }>;

// Below this much text to scan, a worker costs more than it saves (starting
// one takes longer than scanning a typical small project).
const INLINE_SCAN_BYTES = 256 * 1024;

const createScanWorker = () =>
  new Worker(new URL("./workers/scan.worker.ts", import.meta.url), { type: "module" });

// Scans on this thread, yielding to the event loop about every frame so the
// spinner keeps animating. Used for small jobs and where Workers do not exist.
const scanInline = async (candidates: { index: number; content: string }[]): Promise<Map<number, Finding>> => {
  const findings = new Map<number, Finding>();
  // Let the "uploading" state paint before any scanning starts.
  await new Promise((resolve) => setTimeout(resolve, 0));
  let sliceStart = performance.now();
  for (const { index, content } of candidates) {
    if (performance.now() - sliceStart > 12) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      sliceStart = performance.now();
    }
    const outcome = scanContent(content);
    if (outcome.kind === "redacted" || outcome.kind === "too-large") findings.set(index, outcome);
  }
  return findings;
};

const scanInWorker = async (candidates: { index: number; content: string }[]): Promise<Map<number, Finding>> => {
  const worker = takeWorker("scan", createScanWorker);
  const results = await runWorkerJob<({ index: number } & Finding)[]>(worker, { files: candidates });
  return new Map(results.map(({ index, ...finding }) => [index, finding as Finding]));
};

/**
 * Scans extracted files for secrets before they are pushed to GitHub.
 * - Files matching known "always sensitive" paths (.env, private keys, credentials, etc.)
 *   are dropped entirely from the push.
 * - Other text files are scanned for common secret patterns (cloud provider keys,
 *   tokens, private key blocks, DB connection strings, etc.) and any matches are
 *   replaced with a "[REDACTED-SECRET]" placeholder so the push still succeeds
 *   without leaking credentials.
 * - Binary files are left untouched (never text-scanned): known binary extensions,
 *   and anything whose content contains a NUL byte.
 * - Files over MAX_SCAN_BYTES are left untouched and listed in report.unscannedFiles.
 *
 * The scan runs in a Web Worker when there is enough to scan, so the page stays
 * responsive; otherwise (small jobs, no Worker support, or a worker failure) it
 * runs on this thread in short slices. Both use the same code, so the result is
 * the same either way. Files come back in their original order.
 */
export const sanitizeFiles = async (
  files: ExtractedFile[]
): Promise<{ sanitized: ExtractedFile[]; report: SanitizeReport }> => {
  const report: SanitizeReport = { skippedFiles: [], redactedFiles: [], unscannedFiles: [] };

  // Cheap, path-only decisions first, so excluded and binary files are never
  // copied to a worker or decoded.
  const candidates: { index: number; content: string }[] = [];
  let candidateBytes = 0;
  files.forEach((file, index) => {
    if (isExcludedPath(file.path) || isBinaryPath(file.path)) return;
    candidates.push({ index, content: file.content });
    candidateBytes += estimateBytesFromBase64(file.content);
  });

  let findings: Map<number, Finding>;
  if (candidates.length === 0) {
    findings = new Map();
  } else if (workersSupported() && candidateBytes > INLINE_SCAN_BYTES) {
    try {
      findings = await scanInWorker(candidates);
    } catch (err) {
      console.warn("Scanning in a worker failed; scanning on the main thread instead.", err);
      findings = await scanInline(candidates);
    }
  } else {
    findings = await scanInline(candidates);
  }

  const sanitized: ExtractedFile[] = [];
  files.forEach((file, index) => {
    if (isExcludedPath(file.path)) {
      report.skippedFiles.push(file.path);
      return;
    }
    const finding = findings.get(index);
    if (finding?.kind === "redacted") {
      report.redactedFiles.push({ path: file.path, matches: finding.matches });
      sanitized.push({ path: file.path, content: finding.content });
      return;
    }
    if (finding?.kind === "too-large") report.unscannedFiles.push(file.path);
    sanitized.push(file);
  });

  return { sanitized, report };
};
