import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { precompressDir, isCompressible } from "./precompress.mjs";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ztg-precompress-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (rel: string, content: string | Buffer) => {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
};
const text = "const answer = 42; // the quick brown fox jumps over the lazy dog\n".repeat(100);

describe("isCompressible", () => {
  it("picks text formats and leaves already-compressed ones and the server bundle alone", () => {
    for (const f of ["a.js", "b.css", "c.html", "d.svg", "e.json", "f.xml", "g.txt"]) expect(isCompressible(f)).toBe(true);
    for (const f of ["a.woff2", "b.png", "c.jpg", "d.ico", "e.js.map", "server.cjs", "f.br", "g.gz"]) expect(isCompressible(f)).toBe(false);
  });
});

describe("precompressDir", () => {
  it("writes .br and .gz copies that decode to exactly the original", () => {
    const file = write("assets/app.js", text);
    precompressDir(dir);
    const original = fs.readFileSync(file);
    expect(zlib.brotliDecompressSync(fs.readFileSync(file + ".br")).equals(original)).toBe(true);
    expect(zlib.gunzipSync(fs.readFileSync(file + ".gz")).equals(original)).toBe(true);
    expect(fs.statSync(file + ".br").size).toBeLessThan(original.length);
  });

  it("walks sub-folders (prerendered pages live in dist/<slug>/index.html)", () => {
    write("faq/index.html", "<p>hello world</p>".repeat(200));
    precompressDir(dir);
    expect(fs.existsSync(path.join(dir, "faq/index.html.br"))).toBe(true);
  });

  it("skips tiny files, images, fonts and the server bundle", () => {
    write("tiny.js", "x");
    write("pic.png", Buffer.alloc(5000, 1));
    write("fonts/a.woff2", Buffer.alloc(5000, 2));
    write("server.cjs", text);
    expect(precompressDir(dir)).toEqual([]);
    expect(fs.readdirSync(dir).filter((n) => /\.(br|gz)$/.test(n))).toEqual([]);
  });

  it("keeps a copy only when it is smaller than the original", () => {
    // Random bytes do not compress: the copies would be bigger, so none are kept.
    write("noise.js", Buffer.from(Array.from({ length: 4000 }, () => Math.floor(Math.random() * 256))));
    const [row] = precompressDir(dir);
    expect(row.br).toBeNull();
    expect(row.gz).toBeNull();
    expect(fs.existsSync(path.join(dir, "noise.js.br"))).toBe(false);
  });

  it("removes a stale copy left by an earlier run when the new one would not be smaller", () => {
    const file = write("noise.js", Buffer.from(Array.from({ length: 4000 }, () => Math.floor(Math.random() * 256))));
    fs.writeFileSync(file + ".br", "stale");
    precompressDir(dir);
    expect(fs.existsSync(file + ".br")).toBe(false);
  });

  it("is safe to run twice, and never compresses its own output", () => {
    write("a.js", text);
    precompressDir(dir);
    const second = precompressDir(dir);
    expect(second.map((r: any) => r.file)).toEqual(["a.js"]);
    expect(fs.existsSync(path.join(dir, "a.js.br.br"))).toBe(false);
  });
});
