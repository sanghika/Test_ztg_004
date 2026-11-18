import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";
import { chooseEncoding, scanPrecompressed, servePrecompressed } from "./precompressed";
import { precompressDir } from "../scripts/precompress.mjs";

describe("chooseEncoding", () => {
  const both = { file: "/x.js", br: "/x.js.br", gzip: "/x.js.gz" };

  it("prefers Brotli for a browser-style header, whatever order the client lists them in", () => {
    expect(chooseEncoding("gzip, deflate, br, zstd", both)).toBe("br");
    expect(chooseEncoding("br, gzip", both)).toBe("br");
    expect(chooseEncoding("gzip, br", both)).toBe("br");
  });

  it("falls back to gzip when the client does not take Brotli", () => {
    expect(chooseEncoding("gzip, deflate", both)).toBe("gzip");
    expect(chooseEncoding("gzip", both)).toBe("gzip");
    expect(chooseEncoding("x-gzip", both)).toBe("gzip");
  });

  it("honours q-values", () => {
    expect(chooseEncoding("br;q=0, gzip", both)).toBe("gzip");
    expect(chooseEncoding("gzip;q=1.0, br;q=0.5", both)).toBe("gzip");
    expect(chooseEncoding("gzip;q=0.5, br;q=1.0", both)).toBe("br");
    expect(chooseEncoding("br;q=0, gzip;q=0", both)).toBeNull();
  });

  it("understands the wildcard", () => {
    expect(chooseEncoding("*", both)).toBe("br");
    expect(chooseEncoding("gzip, *;q=0", both)).toBe("gzip");
  });

  it("sends nothing compressed when the client asks for none, or the copy is missing", () => {
    expect(chooseEncoding(undefined, both)).toBeNull();
    expect(chooseEncoding("", both)).toBeNull();
    expect(chooseEncoding("identity", both)).toBeNull();
    expect(chooseEncoding("br", { file: "/x.js", gzip: "/x.js.gz" })).toBeNull();
    expect(chooseEncoding("gzip, br", { file: "/x.js", gzip: "/x.js.gz" })).toBe("gzip");
  });

  it("ignores malformed q-values instead of throwing", () => {
    expect(chooseEncoding("br;q=banana, gzip", both)).toBe("gzip");
  });
});

describe("serving precompressed files", () => {
  let root: string;
  const js = "export const answer = 42; // the quick brown fox\n".repeat(200);
  const html = "<p>hello from the prerendered page</p>".repeat(100);

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ztg-static-"));
    fs.mkdirSync(path.join(root, "assets"));
    fs.mkdirSync(path.join(root, "faq"));
    fs.writeFileSync(path.join(root, "assets/app-abc123.js"), js);
    fs.writeFileSync(path.join(root, "faq/index.html"), html);
    fs.writeFileSync(path.join(root, "plain.txt"), "tiny"); // too small to have copies
    precompressDir(root);
    // A copy whose original is gone must never be served.
    fs.writeFileSync(path.join(root, "orphan.js.br"), "orphan");
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  const makeApp = () => {
    const app = express();
    app.use(
      servePrecompressed(scanPrecompressed(root), {
        root,
        cacheControl: (f) => (f.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache"),
      })
    );
    app.use(express.static(root, { index: false }));
    return app;
  };

  // supertest decodes gzip and Brotli bodies itself, which would hide what is
  // really on the wire. This reads the raw bytes over a real socket.
  const raw = (app: express.Express, urlPath: string, headers: Record<string, string>) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      const server = app.listen(0, () => {
        const { port } = server.address() as { port: number };
        http
          .get({ host: "127.0.0.1", port, path: urlPath, headers }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => {
              server.close();
              resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) });
            });
          })
          .on("error", (e) => {
            server.close();
            reject(e);
          });
      });
    });

  it("sends the Brotli copy, with the original's type and the original's cache policy", async () => {
    const res = await raw(makeApp(), "/assets/app-abc123.js", { "Accept-Encoding": "gzip, deflate, br" });
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("br");
    expect(res.headers["content-type"]).toMatch(/javascript/);
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(res.headers["vary"]).toMatch(/Accept-Encoding/i);
    expect(zlib.brotliDecompressSync(res.body).toString()).toBe(js);
  });

  it("sends the gzip copy to a client that does not take Brotli", async () => {
    const res = await raw(makeApp(), "/assets/app-abc123.js", { "Accept-Encoding": "gzip" });
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(zlib.gunzipSync(res.body).toString()).toBe(js);
  });

  it("sends the plain file, unencoded, to a client that accepts neither", async () => {
    const res = await request(makeApp()).get("/assets/app-abc123.js").set("Accept-Encoding", "identity");
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.text).toBe(js);
    expect(res.headers["vary"]).toMatch(/Accept-Encoding/i);
  });

  it("serves a prerendered page under its URL and answers HEAD with the same headers", async () => {
    const res = await raw(makeApp(), "/faq/index.html", { "Accept-Encoding": "br" });
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(zlib.brotliDecompressSync(res.body).toString()).toBe(html);

    const head = await request(makeApp()).head("/assets/app-abc123.js").set("Accept-Encoding", "br");
    expect(head.status).toBe(200);
    expect(head.headers["content-encoding"]).toBe("br");
  });

  it("answers a repeat request with 304 for the same representation only", async () => {
    const first = await request(makeApp()).get("/assets/app-abc123.js").set("Accept-Encoding", "br");
    const etag = first.headers["etag"];
    expect(etag).toBeTruthy();
    const again = await request(makeApp()).get("/assets/app-abc123.js").set({ "Accept-Encoding": "br", "If-None-Match": etag });
    expect(again.status).toBe(304);
    const other = await request(makeApp()).get("/assets/app-abc123.js").set({ "Accept-Encoding": "gzip", "If-None-Match": etag });
    expect(other.status).toBe(200);
  });

  it("leaves files without copies to express.static, and never serves an orphaned copy", async () => {
    const plain = await request(makeApp()).get("/plain.txt").set("Accept-Encoding", "br");
    expect(plain.status).toBe(200);
    expect(plain.headers["content-encoding"]).toBeUndefined();

    const orphan = await request(makeApp()).get("/orphan.js").set("Accept-Encoding", "br");
    expect(orphan.status).toBe(404);
  });

  it("does not let the request pick the file: odd paths and POSTs fall through", async () => {
    const app = makeApp();
    expect((await request(app).get("/assets/../assets/app-abc123.js.br").set("Accept-Encoding", "br")).headers["content-encoding"]).not.toBe("br");
    expect((await request(app).get("/%E0%A4%A").set("Accept-Encoding", "br")).status).toBe(404); // bad escape: no throw
    expect((await request(app).post("/assets/app-abc123.js").set("Accept-Encoding", "br")).status).toBe(404);
  });
});

describe("scanPrecompressed", () => {
  it("returns an empty index for a folder with no copies, or no folder at all", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "ztg-empty-"));
    fs.writeFileSync(path.join(empty, "a.js"), "x".repeat(5000));
    try {
      expect(scanPrecompressed(empty).byUrl.size).toBe(0);
      expect(scanPrecompressed(path.join(empty, "nope")).byUrl.size).toBe(0);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
