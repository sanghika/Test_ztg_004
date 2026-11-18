// Pre-compresses the built site: for each text file in dist/ this writes a
// Brotli (.br) and a gzip (.gz) copy next to it, and the server sends those
// instead of compressing the same bytes again on every request.
//
// Why this is worth a build step: Brotli at its best setting (quality 11) makes
// the main JS bundle about 14% smaller than gzip or the quality-4 Brotli the
// `compression` middleware uses, but takes over half a second per compression.
// That is far too slow to do per request, and costs nothing once, at build time.
//
// Run after everything that writes into dist/ (so after the prerender step):
//   node scripts/precompress.mjs [dist]
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

// Formats that shrink well. Images, fonts (woff2) and the like are already
// compressed and are left alone. Source maps and the server bundle are not
// requested by browsers.
export const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".svg", ".json", ".xml", ".txt", ".webmanifest"]);
export const SKIP_FILES = new Set(["server.cjs"]);
// Below this a compressed copy saves next to nothing (and `compression`
// itself skips responses under 1 KB).
export const MIN_BYTES = 1024;

export const brotli = (buf) =>
  zlib.brotliCompressSync(buf, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
    },
  });
export const gzip = (buf) => zlib.gzipSync(buf, { level: 9 });

export const isCompressible = (file) =>
  COMPRESSIBLE.has(path.extname(file).toLowerCase()) && !SKIP_FILES.has(path.basename(file));

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

/**
 * Writes `<file>.br` and `<file>.gz` for every compressible file under `dir`,
 * keeping a copy only when it is actually smaller than the original.
 * Returns what was written, for the build log and the tests.
 */
export function precompressDir(dir) {
  const results = [];
  for (const file of walk(dir)) {
    if (!isCompressible(file)) continue;
    const original = fs.readFileSync(file);
    if (original.length < MIN_BYTES) continue;
    const row = { file: path.relative(dir, file), bytes: original.length, br: null, gz: null };
    for (const [key, ext, compress] of [["br", ".br", brotli], ["gz", ".gz", gzip]]) {
      const out = compress(original);
      if (out.length < original.length) {
        fs.writeFileSync(file + ext, out);
        row[key] = out.length;
      } else {
        fs.rmSync(file + ext, { force: true }); // a leftover from an earlier run must not be served
      }
    }
    results.push(row);
  }
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(process.argv[2] || "dist");
  if (!fs.existsSync(dir)) {
    console.error(`precompress: ${dir} does not exist (run the build first)`);
    process.exit(1);
  }
  const results = precompressDir(dir);
  const kb = (n) => (n == null ? "   -   " : `${(n / 1024).toFixed(1).padStart(6)}K`);
  for (const r of results) console.log(`precompress ${kb(r.bytes)}  br ${kb(r.br)}  gz ${kb(r.gz)}  ${r.file}`);
  console.log(`precompress: ${results.length} files`);
}
