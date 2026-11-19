import { estimateBytesFromBase64, MAX_TOTAL_UPLOAD_BYTES, MAX_SINGLE_FILE_BYTES } from "./uploadLimits";
import { extractZipEntries } from "./zipExtract";
import { shouldSkipUploadPath } from "./uploadPaths";
import { prewarmWorker, runWorkerJob, takeWorker, workersSupported, WorkerUnavailableError } from "./workerJob";
import { encodeUploadBody, type PreparedUploadBody } from "./uploadBody";

export interface ExtractedFile {
  path: string;
  content: string; // base64 encoded
  executable?: boolean;
}

export interface RepoTreeEntry {
  path: string;
  type: "blob" | "tree";
  sha: string;
  size?: number;
}

const formatMB = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
// Sanity ceiling on the raw (compressed) ZIP file itself, checked before we
// even attempt to load it into memory — JSZip.loadAsync on a huge archive
// can hang or crash the tab well before we get to inspect individual files.
const MAX_RAW_ZIP_BYTES = 200 * 1024 * 1024; // 200MB

// Nothing needs JSZip until a ZIP is picked, so it is a separate chunk loaded
// on first use instead of part of the first download. (Only the fallback below
// loads it on the main thread; the worker bundles its own copy.)
const loadJSZip = () => import("jszip").then((m) => m.default);

const createExtractWorker = () =>
  new Worker(new URL("./workers/extract.worker.ts", import.meta.url), { type: "module" });

/**
 * Gets ZIP extraction ready in the background so the first extractZip does not
 * wait for a download: starts the worker where Workers exist, otherwise
 * fetches the JSZip chunk for the main-thread fallback.
 */
export const warmZipExtractor = (): void => {
  if (workersSupported()) prewarmWorker("extract", createExtractWorker);
  else loadJSZip().catch(() => {});
};

const extractZipInWorker = async (
  file: File,
  onProgress?: (filename: string) => void
): Promise<ExtractedFile[]> => {
  const result: ExtractedFile[] = [];
  await runWorkerJob<null>(takeWorker("extract", createExtractWorker), { file }, (m) => {
    if (m.type === "files") {
      result.push(...m.files);
      onProgress?.(m.files[m.files.length - 1].path);
    }
  });
  return result;
};

const extractZipOnMainThread = async (
  file: File,
  onProgress?: (filename: string) => void
): Promise<ExtractedFile[]> => {
  const result: ExtractedFile[] = [];
  const JSZipClass = await loadJSZip();
  await extractZipEntries(JSZipClass, file, {
    onFile: (entry) => {
      result.push(entry);
      onProgress?.(entry.path);
    },
    yieldBetweenBatches: true,
  });
  return result;
};

// ZIP extraction happens entirely client-side and needs no GitHub token. The
// heavy part (parsing the archive, base64-encoding every entry) runs in a Web
// Worker so the page stays responsive; if the browser cannot start one, the
// same code runs on the main thread instead.
export const extractZip = async (
  file: File,
  onProgress?: (filename: string) => void
): Promise<ExtractedFile[]> => {
  if (file.size > MAX_RAW_ZIP_BYTES) {
    throw new Error(
      `This ZIP file is ${formatMB(file.size)}, which is over the ${formatMB(MAX_RAW_ZIP_BYTES)} limit. Try a smaller archive.`
    );
  }

  if (workersSupported()) {
    try {
      return await extractZipInWorker(file, onProgress);
    } catch (err) {
      // Only "the worker never started" falls back. A real error (a bad ZIP, a
      // size limit) would just happen again, and is reported as it is.
      if (!(err instanceof WorkerUnavailableError)) throw err;
    }
  }
  return extractZipOnMainThread(file, onProgress);
};

const fileToBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // reader.result is a data URL like "data:<mime>;base64,<data>" —
      // we only want the part after the comma.
      const dataUrl = reader.result as string;
      const comma = dataUrl.indexOf(",");
      resolve(comma === -1 ? "" : dataUrl.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error || new Error(`Failed to read "${file.name}"`));
    reader.readAsDataURL(file);
  });

// Folder extraction happens entirely client-side, mirroring extractZip's
// validation (size limits, junk-file exclusion, common-root stripping) so a
// picked/dragged folder feeds the exact same downstream pipeline a ZIP does.
export const extractFolder = async (
  files: File[],
  onProgress?: (filename: string) => void
): Promise<ExtractedFile[]> => {
  const entries = files
    .map((file) => ({ file, path: file.webkitRelativePath || file.name }))
    .filter(({ path }) => !shouldSkipUploadPath(path));

  if (entries.length === 0) {
    throw new Error("This folder doesn't contain any files to upload.");
  }

  // Folder pickers/drops nest everything under the chosen folder's name
  // (e.g. "my-project/src/App.tsx"); strip that shared root so files land at
  // the repo root, same as extractZip does for wrapped ZIPs.
  const firstSegment = (p: string) => p.split("/")[0];
  const rootFolder = firstSegment(entries[0].path);
  const allShareRoot =
    rootFolder !== "" && entries.every((e) => e.path.includes("/") && firstSegment(e.path) === rootFolder);
  if (allShareRoot) {
    for (const e of entries) {
      e.path = e.path.slice(rootFolder.length + 1);
    }
  }

  const result: ExtractedFile[] = [];
  let totalBytes = 0;
  const MAX_CONCURRENT_EXTRACT = 6;
  for (let i = 0; i < entries.length; i += MAX_CONCURRENT_EXTRACT) {
    const batch = entries.slice(i, i + MAX_CONCURRENT_EXTRACT);

    // Size limits are checked up front (synchronously, before any reads in
    // this batch) so an oversized file fails fast without paying for the
    // FileReader round trip on it or its batch-mates first.
    for (const { file, path } of batch) {
      if (file.size > MAX_SINGLE_FILE_BYTES) {
        throw new Error(
          `"${path}" is ${formatMB(file.size)}, which is over GitHub's ${formatMB(MAX_SINGLE_FILE_BYTES)} per-file limit. Remove it and try again.`
        );
      }
      totalBytes += file.size;
      if (totalBytes > MAX_TOTAL_UPLOAD_BYTES) {
        throw new Error(
          `This folder is larger than the ${formatMB(MAX_TOTAL_UPLOAD_BYTES)} total upload limit. Try removing large/unnecessary files (e.g. node_modules, build output) first.`
        );
      }
    }

    const batchResults = await Promise.all(
      batch.map(async ({ file, path }) => ({ path, content: await fileToBase64(file) }))
    );
    for (const { path } of batchResults) onProgress?.(path);
    result.push(...batchResults);

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return result;
};

// Recursively walks a dropped folder's DataTransferItem entries into a flat
// File[] with webkitRelativePath set, so a dragged folder can be fed through
// extractFolder exactly like one chosen via the <input webkitdirectory>
// picker. Falls back gracefully if the browser doesn't support this API.
export const filesFromDataTransferItems = async (items: DataTransferItemList): Promise<File[]> => {
  const readEntry = async (entry: FileSystemEntry, pathPrefix: string): Promise<File[]> => {
    const path = pathPrefix + entry.name;
    if (shouldSkipUploadPath(path)) return [];

    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => {
        (entry as FileSystemFileEntry).file(resolve, () => reject(new Error(`Could not read "${path}".`)));
      });
      try {
        Object.defineProperty(file, "webkitRelativePath", { value: path, configurable: true });
      } catch {
        // Some browsers already provide this property or disallow overriding it.
      }
      return [file];
    }
    if (!entry.isDirectory) return [];

    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const entries: FileSystemEntry[] = [];
    while (true) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
        reader.readEntries(resolve, () => reject(new Error(`Could not read folder "${path}".`)));
      });
      if (!batch.length) break;
      entries.push(...batch);
    }
    const nested = await Promise.all(entries.map((child) => readEntry(child, path + "/")));
    return nested.flat();
  };

  const topLevel = Array.from(items)
    .map((item) => (item.kind === "file" ? item.webkitGetAsEntry?.() : null))
    .filter((entry): entry is FileSystemEntry => !!entry);

  const nested = await Promise.all(topLevel.map((entry) => readEntry(entry, "")));
  return nested.flat();
};

// --- Authenticated calls to our own server, which holds the GitHub token --- //
// The browser never sees the GitHub access token: it lives only in an HttpOnly
// session cookie, which `credentials: "include"` sends automatically.

class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const res = await fetch(path, { ...options, credentials: "include" });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      if (data?.message) message = data.message;
    } catch {
      // response wasn't JSON — keep the generic message
    }
    throw new ApiError(message, res.status);
  }
  return res;
}

// Reads a newline-delimited JSON progress stream from our upload/delete
// endpoints. Each line is either a progress event or the final {"done": true}.
async function readNdjsonStream<T>(
  res: Response,
  onProgress?: (status: string, current?: number, total?: number) => void
): Promise<T> {
  const reader = res.body?.getReader();
  if (!reader) {
    // Fallback for environments without a streaming body reader.
    const text = await res.text();
    const lines = text.split("\n").filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]);
    if (last.error) throw new Error(last.error);
    return last as T;
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let result: any = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const evt = JSON.parse(line);
      if (evt.done) {
        result = evt;
      } else if (onProgress) {
        onProgress(evt.status, evt.current, evt.total);
      }
    }
  }

  if (!result) throw new Error("Connection closed before the operation finished.");
  if (result.error) throw new Error(result.error);
  return result as T;
}

// What GET /api/bootstrap returns: the user plus the FIRST page of repositories.
export interface BootstrapData {
  user: { login: string; avatar_url: string };
  repos: RepoSummary[];
  /** Next page to request with fetchRepositories(), or null when there is none. */
  nextPage: number | null;
}
export interface RepoSummary {
  id: number;
  name: string;
  full_name: string;
  default_branch?: string;
}

// index.html starts GET /api/bootstrap from an inline script (only on "/" and
// only when the has_session flag is set), in parallel with the JS download,
// and leaves the outcome on window.__ZTG_BOOT__. The first fetchBootstrap()
// call takes it, so the request is not made twice. Later calls (after the
// OAuth popup, say) always make a fresh request.
type EarlyBootstrap = { ok: boolean; status: number; body: any };
declare global {
  interface Window {
    __ZTG_BOOT__?: Promise<EarlyBootstrap>;
  }
}

const takeEarlyBootstrap = (): Promise<EarlyBootstrap> | undefined => {
  if (typeof window === "undefined") return undefined;
  const early = window.__ZTG_BOOT__;
  delete window.__ZTG_BOOT__;
  return early;
};

export const fetchBootstrap = async (): Promise<BootstrapData> => {
  const early = takeEarlyBootstrap();
  if (early) {
    let result: EarlyBootstrap | undefined;
    try {
      result = await early;
    } catch {
      // The early request never got an answer (network error). Fall through
      // to a normal request, which reports the failure the usual way.
    }
    if (result) {
      if (result.ok) return result.body;
      // Same shape apiFetch() throws, so callers cannot tell the two apart.
      throw new ApiError(result.body?.message || `Request failed (${result.status})`, result.status);
    }
  }
  const res = await apiFetch("/api/bootstrap");
  return res.json();
};

// One further page of the repository list (page 1 comes with fetchBootstrap).
export const fetchRepositories = async (page: number, signal?: AbortSignal): Promise<{ repos: RepoSummary[]; nextPage: number | null }> => {
  const res = await apiFetch(`/api/repos?page=${page}`, { signal });
  return res.json();
};

export const createRepository = async (name: string, isPrivate: boolean): Promise<RepoSummary> => {
  const res = await apiFetch("/api/repos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, isPrivate }),
  });
  return res.json();
};

// `branch` is the repository's default branch from the repo list. It lets the
// server list the files in one GitHub request instead of three. `truncated` is
// true when GitHub cut the list off (very large repositories): the tree is then
// only part of the repository.
export const fetchRepoTree = async (
  owner: string,
  repo: string,
  branch?: string
): Promise<{ tree: RepoTreeEntry[]; defaultBranch: string; truncated: boolean }> => {
  const params = new URLSearchParams({ owner, repo });
  if (branch) params.set("branch", branch);
  const res = await apiFetch(`/api/repo-tree?${params}`);
  return res.json();
};

export const deleteRepository = async (owner: string, repo: string): Promise<void> => {
  await apiFetch("/api/repo", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ owner, repo }),
  });
};

export const logout = async (): Promise<void> => {
  await apiFetch("/api/logout", { method: "POST" });
};

// --- Batched upload --- //
// A push is sent as several small requests instead of one request holding the
// whole ZIP as base64 JSON:
//   /api/upload/blobs   once per batch of files: GitHub stores the contents, we get SHAs back
//   /api/upload/commit  once: one tree + one commit from the list of entries
// This keeps the transient JSON.stringify copy to one batch at a time instead of
// the whole upload, and gives the progress bar a real step after every batch.
// Nothing has to happen before the first batch: the server only looks at the
// repository (and initializes it, if it is empty) when GitHub says it must.

// Roughly how much base64 goes into one /blobs request. A file bigger than this
// is sent on its own (it cannot be split), so one request can be as large as
// the biggest single file, which the server's /blobs limit allows for.
const MAX_BATCH_BASE64_CHARS = 4 * 1024 * 1024;
// Caps how many files share a request, so a folder of thousands of tiny files
// does not become one long-running request.
const MAX_BATCH_FILES = 100;

/** Splits files, in order, into batches of at most `maxChars` base64 characters and `maxFiles` files. */
export const planUploadBatches = <T extends { path: string; content: string }>(
  files: T[],
  maxChars = MAX_BATCH_BASE64_CHARS,
  maxFiles = MAX_BATCH_FILES
): T[][] => {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentChars = 0;
  for (const file of files) {
    const size = file.content.length + file.path.length;
    if (current.length > 0 && (current.length >= maxFiles || currentChars + size > maxChars)) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(file);
    currentChars += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
};

// Small text files do not need a blob request of their own: their text goes
// along with the commit and GitHub creates the blob while it builds the tree.
// That is one API call fewer per file (and those calls are what GitHub throttles).
// Both caps keep the commit request small; it is limited to 5 MB on the server,
// and GitHub's own limit on a tree request is 7 MB.
const MAX_INLINE_FILE_BYTES = 32 * 1024;
const MAX_INLINE_TOTAL_BYTES = 2 * 1024 * 1024;

// Returns the file's text when it is a non-empty, valid UTF-8, NUL-free file
// small enough to inline, otherwise null (it is then sent as a blob, byte for
// byte). Empty files stay blobs because GitHub reads empty `content` as "no
// content given". `ignoreBOM: true` keeps a leading byte-order mark in the text
// instead of silently dropping it.
const inlineTextOf = (base64: string): string | null => {
  if (base64.length === 0) return null;
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      const byte = binary.charCodeAt(i);
      if (byte === 0) return null; // NUL: treat as binary
      bytes[i] = byte;
    }
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null; // not valid UTF-8 (or not valid base64)
  }
};

type InlineUploadEntry = Pick<ExtractedFile, "path" | "executable"> & { content: string };

/** Splits files into small text files to send with the commit and everything else, which goes up as blobs. */
export const splitInlineText = (
  files: ExtractedFile[]
): { inline: InlineUploadEntry[]; blobFiles: ExtractedFile[] } => {
  const inline: InlineUploadEntry[] = [];
  const blobFiles: ExtractedFile[] = [];
  let inlineBytes = 0;
  for (const file of files) {
    const bytes = estimateBytesFromBase64(file.content);
    const fits = bytes <= MAX_INLINE_FILE_BYTES && inlineBytes + bytes <= MAX_INLINE_TOTAL_BYTES;
    const text = fits ? inlineTextOf(file.content) : null;
    if (text !== null) {
      inline.push({ ...file, content: text });
      inlineBytes += bytes;
    } else {
      blobFiles.push(file);
    }
  }
  return { inline, blobFiles };
};

type UploadEntry = InlineUploadEntry | (Pick<ExtractedFile, "path" | "executable"> & { sha: string });
type UploadBody = { owner: string; repo: string } &
  ({ files: ExtractedFile[] } | { entries: UploadEntry[]; commitMessage: string });

const WORKER_UPLOAD_CHARS = 1024 * 1024;

async function prepareUploadBody(body: UploadBody): Promise<PreparedUploadBody> {
  const entries = "files" in body ? body.files : body.entries;
  // A size estimate avoids serializing solely to decide where to serialize.
  const chars = entries.reduce(
    (sum, entry) => sum + entry.path.length + ("content" in entry ? entry.content.length : entry.sha.length),
    "commitMessage" in body ? body.commitMessage.length : 0
  );
  if (chars >= WORKER_UPLOAD_CHARS && workersSupported()) {
    try {
      const worker = new Worker(new URL("./workers/uploadBody.worker.ts", import.meta.url), { type: "module" });
      return await runWorkerJob<PreparedUploadBody>(worker, body);
    } catch {
      // Preparing the body has no network side effects, so it can be repeated.
    }
  }
  return encodeUploadBody(body);
}

// Network drops and gateway errors are worth another try for the requests that
// are safe to repeat: blobs are content-addressed, so sending a batch again
// changes nothing. The commit request is NOT retried, because a commit that did
// go through but whose answer was lost would be repeated as a second, empty commit.
const isTransientFailure = (err: unknown): boolean =>
  err instanceof ApiError ? [502, 503, 504].includes(err.status) : err instanceof TypeError;

async function postUpload<T>(path: string, body: UploadBody, { retry = false } = {}): Promise<T> {
  const { payload, contentEncoding } = await prepareUploadBody(body);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (contentEncoding) headers["Content-Encoding"] = contentEncoding;

  const MAX_ATTEMPTS = retry ? 3 : 1;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await apiFetch(path, { method: "POST", headers, body: payload });
      return (await res.json()) as T;
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS || !isTransientFailure(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
}

export const uploadToGitHub = async (
  owner: string,
  repo: string,
  files: ExtractedFile[],
  commitMessage: string,
  onProgress: (status: string, current: number, total: number) => void
) => {
  const { inline, blobFiles } = splitInlineText(files);

  // Steps: one per file that goes up as a blob, then the commit and its finish.
  const total = blobFiles.length + 2;
  const entries: UploadEntry[] = [...inline];
  const executablePaths = new Set(blobFiles.filter((file) => file.executable).map((file) => file.path));

  const uploadingMessage = (done: number) => `Uploading files (${done}/${blobFiles.length})...`;
  let uploaded = 0;
  if (blobFiles.length > 0) onProgress(uploadingMessage(0), 0, total);
  for (const batch of planUploadBatches(blobFiles)) {
    const result = await postUpload<{ blobs: { path: string; sha: string }[] }>(
      "/api/upload/blobs",
      { owner, repo, files: batch },
      { retry: true }
    );
    if (!Array.isArray(result.blobs) || result.blobs.length !== batch.length) {
      throw new Error("The server did not confirm every file in this upload. Please try again.");
    }
    entries.push(...result.blobs.map((blob) => executablePaths.has(blob.path) ? { ...blob, executable: true } : blob));
    uploaded += batch.length;
    onProgress(uploadingMessage(uploaded), uploaded, total);
  }

  onProgress("Committing changes...", blobFiles.length + 1, total);
  const { commit } = await postUpload<{ commit: any }>(
    "/api/upload/commit",
    { owner, repo, entries, commitMessage }
  );
  onProgress("Finalizing...", total, total);
  return commit;
};

export const deleteRepoPaths = async (
  owner: string,
  repo: string,
  selectedPaths: string[],
  commitMessage: string,
  onProgress?: (status: string) => void
) => {
  const res = await apiFetch("/api/delete-paths", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ owner, repo, paths: selectedPaths, commitMessage }),
  });
  const result = await readNdjsonStream<{ commit: any }>(res, (status) => onProgress?.(status));
  return result.commit;
};
