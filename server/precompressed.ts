import fs from "fs";
import path from "path";
import type { Request, RequestHandler, Response } from "express";

// Serves the `.br` / `.gz` copies that scripts/precompress.mjs wrote next to the
// built files, so a static request costs a file read instead of a compression.
// Anything without a copy (or a client that accepts neither encoding) falls
// through to express.static and the `compression` middleware as before.

export type Encoding = "br" | "gzip";

export interface PrecompressedEntry {
  /** Absolute path of the original file. */
  file: string;
  /** Absolute paths of the compressed copies that exist. */
  br?: string;
  gzip?: string;
}

export interface PrecompressedIndex {
  /** By URL path ("/assets/app-123.js"), for files express.static would serve. */
  byUrl: Map<string, PrecompressedEntry>;
  /** By absolute path of the original, for pages sent with res.sendFile. */
  byFile: Map<string, PrecompressedEntry>;
}

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

/**
 * Looks at `root` once, at startup, and records which files have compressed
 * copies. Requests are then answered from this table only: no file path is ever
 * built from the request, so there is nothing to traverse out of `root` with.
 */
export function scanPrecompressed(root: string): PrecompressedIndex {
  const byUrl = new Map<string, PrecompressedEntry>();
  const byFile = new Map<string, PrecompressedEntry>();
  if (!fs.existsSync(root)) return { byUrl, byFile };

  for (const file of walk(root)) {
    const ext = path.extname(file);
    if (ext !== ".br" && ext !== ".gz") continue;
    const original = file.slice(0, -ext.length);
    if (!fs.existsSync(original)) continue; // an orphaned copy is never served
    let entry = byFile.get(original);
    if (!entry) {
      entry = { file: original };
      byFile.set(original, entry);
      byUrl.set("/" + path.relative(root, original).split(path.sep).join("/"), entry);
    }
    if (ext === ".br") entry.br = file;
    else entry.gzip = file;
  }
  return { byUrl, byFile };
}

// The q-value a client gave an encoding: its own entry, else "*", else not accepted.
const qualityOf = (header: string, names: string[]): number => {
  let star: number | undefined;
  let named: number | undefined;
  for (const part of header.split(",")) {
    const [token, ...params] = part.trim().split(";");
    const name = token.trim().toLowerCase();
    const qParam = params.map((p) => p.trim()).find((p) => /^q=/i.test(p));
    const q = qParam ? Number(qParam.slice(2)) : 1;
    const value = Number.isFinite(q) ? q : 0;
    if (name === "*") star = value;
    else if (names.includes(name)) named = Math.max(named ?? 0, value);
  }
  return named ?? star ?? 0;
};

/**
 * Picks the encoding to send: Brotli when the client accepts it at least as
 * much as gzip (the smaller of the two), gzip otherwise, null when it accepts
 * neither or the file has no copy. Written out instead of using
 * req.acceptsEncodings, which breaks ties by the CLIENT'S order and so picks
 * gzip for browsers that send "gzip, deflate, br".
 */
export function chooseEncoding(acceptEncoding: string | undefined, entry: PrecompressedEntry): Encoding | null {
  if (!acceptEncoding) return null;
  const br = entry.br ? qualityOf(acceptEncoding, ["br"]) : 0;
  const gz = entry.gzip ? qualityOf(acceptEncoding, ["gzip", "x-gzip"]) : 0;
  if (br > 0 && br >= gz) return "br";
  if (gz > 0) return "gzip";
  return null;
}

export interface SendOptions {
  /** The directory the files live in; paths are sent relative to it. */
  root: string;
  /** The Cache-Control for the ORIGINAL file (the same one express.static would use). */
  cacheControl: (originalFile: string) => string;
}

/**
 * Sends the compressed copy of `entry` when the client can take one. Returns
 * false (having sent nothing) when it cannot, so the caller carries on with the
 * normal response.
 */
export function sendPrecompressed(
  req: Request,
  res: Response,
  entry: PrecompressedEntry,
  options: SendOptions,
  fallback: () => void
): boolean {
  // The response now depends on Accept-Encoding, whichever way it goes.
  res.vary("Accept-Encoding");
  const encoding = chooseEncoding(req.headers["accept-encoding"], entry);
  if (!encoding) return false;
  const copy = encoding === "br" ? entry.br! : entry.gzip!;

  // Content-Type follows the ORIGINAL's extension (.js, not .js.br).
  res.type(path.extname(entry.file));
  res.setHeader("Content-Encoding", encoding);
  res.setHeader("Cache-Control", options.cacheControl(entry.file));
  // `root` (with a relative path) rather than an absolute path: sendFile then
  // only applies its dotfile check to the part below root.
  res.sendFile(path.relative(options.root, copy), { root: options.root }, (err) => {
    if (err && !res.headersSent) {
      // The copy vanished or could not be read: undo the headers and let the
      // normal handler answer instead.
      res.removeHeader("Content-Encoding");
      res.removeHeader("Content-Type");
      res.removeHeader("Cache-Control");
      fallback();
    }
  });
  return true;
}

/** Middleware for the files express.static would serve: answers from `index.byUrl`. */
export function servePrecompressed(index: PrecompressedIndex, options: SendOptions): RequestHandler {
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    let urlPath: string;
    try {
      urlPath = decodeURIComponent(req.path);
    } catch {
      return next();
    }
    const entry = index.byUrl.get(urlPath);
    if (!entry || !sendPrecompressed(req, res, entry, options, next)) return next();
  };
}
