import JSZip from "jszip";
import { estimateBytesFromBase64, MAX_TOTAL_UPLOAD_BYTES, MAX_SINGLE_FILE_BYTES } from "./uploadLimits";

export interface ExtractedFile {
  path: string;
  content: string; // base64 encoded
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

// ZIP extraction happens entirely client-side and needs no GitHub token.
export const extractZip = async (
  file: File,
  onProgress?: (filename: string) => void
): Promise<ExtractedFile[]> => {
  if (file.size > MAX_RAW_ZIP_BYTES) {
    throw new Error(
      `This ZIP file is ${formatMB(file.size)}, which is over the ${formatMB(MAX_RAW_ZIP_BYTES)} limit. Try a smaller archive.`
    );
  }

  const result: ExtractedFile[] = [];
  const zip = await JSZip.loadAsync(file);

  const entries: { path: string; entry: JSZip.JSZipObject }[] = [];
  zip.forEach((relativePath, zipEntry) => {
    if (!zipEntry.dir && !relativePath.includes("__MACOSX") && !relativePath.startsWith(".DS_Store")) {
      if (relativePath.includes("../") || relativePath.includes("..\\") || relativePath.startsWith("/")) {
        return;
      }
      entries.push({ path: relativePath, entry: zipEntry });
    }
  });

  // Many ZIP exports wrap every file in one top-level folder (e.g. GitHub's
  // "Download ZIP", `zip -r project.zip myfolder/`) instead of zipping file
  // contents directly. If every entry shares the same first path segment,
  // strip it so files land at the repo root instead of one level deep.
  if (entries.length > 0) {
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
  }

  let totalBytes = 0;
  const MAX_CONCURRENT_EXTRACT = 6;
  for (let i = 0; i < entries.length; i += MAX_CONCURRENT_EXTRACT) {
    const batch = entries.slice(i, i + MAX_CONCURRENT_EXTRACT);
    const batchResults = await Promise.all(
      batch.map(async (item) => ({ item, base64Content: await item.entry.async("base64") }))
    );

    // Applied in original order (not completion order) so size-limit errors
    // are always reported deterministically, and so onProgress still reads
    // like a top-to-bottom walk of the archive.
    for (const { item, base64Content } of batchResults) {
      if (onProgress) onProgress(item.path);

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

      result.push({ path: item.path, content: base64Content });
    }

    // Yield to the event loop between batches (rather than every 10 files)
    // so the progress UI keeps painting without giving up the concurrency win.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return result;
};

// Folders selected via <input webkitdirectory> or dragged onto the dropzone
// commonly carry these — build tooling output, VCS metadata, OS cruft — none
// of which should ever land in the pushed repo.
const EXCLUDED_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  ".parcel-cache",
  "dist",
  "build",
  "coverage",
  "__MACOSX",
  ".DS_Store",
]);
const EXCLUDED_FILE_NAMES = new Set([".DS_Store", "Thumbs.db"]);

const shouldSkipPath = (relativePath: string): boolean => {
  const segments = relativePath.split("/");
  const fileName = segments[segments.length - 1];
  if (EXCLUDED_FILE_NAMES.has(fileName)) return true;
  return segments.some((seg) => EXCLUDED_DIR_NAMES.has(seg));
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
    .map((file) => ({ file, path: (file as any).webkitRelativePath || file.name }))
    .filter(({ path }) => !shouldSkipPath(path));

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
  const readEntry = (entry: any, pathPrefix: string): Promise<File[]> => {
    return new Promise((resolve) => {
      if (entry.isFile) {
        entry.file((file: File) => {
          try {
            Object.defineProperty(file, "webkitRelativePath", {
              value: pathPrefix + file.name,
              configurable: true,
            });
          } catch {
            // Some browsers don't allow redefining this; extractFolder falls
            // back to file.name in that case, which is still usable for a
            // single-level drop.
          }
          resolve([file]);
        });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const allEntries: any[] = [];
        const readBatch = () => {
          reader.readEntries(async (batch: any[]) => {
            if (batch.length === 0) {
              const nested = await Promise.all(
                allEntries.map((e) => readEntry(e, pathPrefix + entry.name + "/"))
              );
              resolve(nested.flat());
            } else {
              allEntries.push(...batch);
              readBatch(); // directory reads can be paginated; keep going
            }
          });
        };
        readBatch();
      } else {
        resolve([]);
      }
    });
  };

  const topLevel = Array.from(items)
    .map((item) => (item.kind === "file" ? item.webkitGetAsEntry?.() : null))
    .filter((entry): entry is any => !!entry);

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

export const fetchUser = async () => {
  const res = await apiFetch("/api/me");
  return res.json();
};

export const fetchRepositories = async () => {
  const res = await apiFetch("/api/repos");
  return res.json();
};

export const createRepository = async (name: string, isPrivate: boolean) => {
  const res = await apiFetch("/api/repos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, isPrivate }),
  });
  return res.json();
};

export const fetchRepoTree = async (
  owner: string,
  repo: string
): Promise<{ tree: RepoTreeEntry[]; defaultBranch: string }> => {
  const res = await apiFetch(`/api/repo-tree?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`);
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

export const uploadToGitHub = async (
  owner: string,
  repo: string,
  files: ExtractedFile[],
  commitMessage: string,
  onProgress: (status: string, current: number, total: number) => void
) => {
  const res = await apiFetch("/api/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ owner, repo, files, commitMessage }),
  });
  const result = await readNdjsonStream<{ commit: any }>(res, (status, current, total) =>
    onProgress(status, current ?? 0, total ?? 0)
  );
  return result.commit;
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
