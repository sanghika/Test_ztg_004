import { describe, it, expect, vi, afterEach } from "vitest";
import zlib from "zlib";
import { planUploadBatches, splitInlineText, uploadToGitHub } from "./github";

const b64 = (data: string | Buffer) => Buffer.from(data).toString("base64");
const file = (path: string, chars: number) => ({ path, content: "A".repeat(chars) });
const textFile = (path: string, text: string) => ({ path, content: b64(text) });
// NUL bytes: never inlined, whatever the size.
const binFile = (path: string, bytes = 10) => ({ path, content: b64(Buffer.alloc(bytes)) });

describe("planUploadBatches", () => {
  it("returns no batches for no files", () => {
    expect(planUploadBatches([])).toEqual([]);
  });

  it("keeps small files together in one batch", () => {
    const files = [file("a.txt", 10), file("b.txt", 10), file("c.txt", 10)];
    expect(planUploadBatches(files)).toEqual([files]);
  });

  it("starts a new batch when the next file would pass the size cap, preserving order", () => {
    const files = [file("a", 60), file("b", 60), file("c", 60), file("d", 60)];
    const batches = planUploadBatches(files, 150, 100);
    expect(batches.map((b) => b.map((f) => f.path))).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("starts a new batch at the file-count cap even when the files are tiny", () => {
    const files = Array.from({ length: 5 }, (_, i) => file(`f${i}`, 1));
    const batches = planUploadBatches(files, 1_000_000, 2);
    expect(batches.map((b) => b.length)).toEqual([2, 2, 1]);
  });

  it("sends a file bigger than the cap on its own rather than splitting or dropping it", () => {
    const files = [file("small", 10), file("huge", 1000), file("after", 10)];
    const batches = planUploadBatches(files, 100, 100);
    expect(batches.map((b) => b.map((f) => f.path))).toEqual([["small"], ["huge"], ["after"]]);
  });

  it("never loses or repeats a file", () => {
    const files = Array.from({ length: 237 }, (_, i) => file(`f${i}`, (i * 37) % 500));
    const flat = planUploadBatches(files, 2000, 20).flat();
    expect(flat.map((f) => f.path)).toEqual(files.map((f) => f.path));
  });
});

describe("splitInlineText", () => {
  it("inlines small UTF-8 text files as their text, and keeps everything else as blobs", () => {
    const { inline, blobFiles } = splitInlineText([
      textFile("src/index.ts", "export const x = 1;\n"),
      textFile("README.md", "# Héllo ✓\n"),
      binFile("logo.png"),
    ]);
    expect(inline).toEqual([
      { path: "src/index.ts", content: "export const x = 1;\n" },
      { path: "README.md", content: "# Héllo ✓\n" },
    ]);
    expect(blobFiles.map((f) => f.path)).toEqual(["logo.png"]);
  });

  it("keeps empty files as blobs, because GitHub reads empty content as 'no content given'", () => {
    const { inline, blobFiles } = splitInlineText([{ path: ".gitkeep", content: "" }]);
    expect(inline).toEqual([]);
    expect(blobFiles.map((f) => f.path)).toEqual([".gitkeep"]);
  });

  it("keeps files that are not valid UTF-8 as blobs, so no byte is ever changed", () => {
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9]); // "café" in Latin-1: 0xE9 alone is invalid UTF-8
    const { inline, blobFiles } = splitInlineText([{ path: "old.txt", content: b64(latin1) }]);
    expect(inline).toEqual([]);
    expect(blobFiles).toHaveLength(1);
  });

  it("keeps files containing a NUL byte as blobs even if the rest is text", () => {
    const { inline } = splitInlineText([{ path: "odd.dat", content: b64(Buffer.from("abc\0def")) }]);
    expect(inline).toEqual([]);
  });

  it("keeps text files over the per-file cap as blobs", () => {
    const { inline, blobFiles } = splitInlineText([textFile("big.txt", "a".repeat(33 * 1024)), textFile("ok.txt", "a".repeat(32 * 1024))]);
    expect(inline.map((f) => f.path)).toEqual(["ok.txt"]);
    expect(blobFiles.map((f) => f.path)).toEqual(["big.txt"]);
  });

  it("stops inlining once the total budget is used, so the commit request stays small", () => {
    const files = Array.from({ length: 80 }, (_, i) => textFile(`f${i}.txt`, "a".repeat(30_000)));
    const { inline, blobFiles } = splitInlineText(files);
    expect(inline.length).toBe(69); // floor(2 MiB / 30,000 bytes)
    expect(blobFiles.length).toBe(11);
    expect(inline.length + blobFiles.length).toBe(80);
  });

  it("round-trips the exact bytes, including a byte-order mark and CRLF line endings", () => {
    const original = Buffer.from("\ufeffline one\r\nline two\r\n✓ 😀\n", "utf-8");
    const { inline } = splitInlineText([{ path: "bom.txt", content: b64(original) }]);
    expect(inline).toHaveLength(1);
    expect(Buffer.from(inline[0].content, "utf-8").equals(original)).toBe(true);
  });
});

// --- uploadToGitHub, against a fake server --- //

type Call = { path: string; body: any; headers: Record<string, string> };

const sha = (n: number) => n.toString(16).padStart(40, "0");
const json = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

// Decodes a request body the way the server does: gunzip when the client said it gzipped it.
const readBody = async (init: RequestInit): Promise<any> => {
  const headers = init.headers as Record<string, string>;
  if (headers["Content-Encoding"] === "gzip") {
    const bytes = Buffer.from(await (init.body as Blob).arrayBuffer());
    return JSON.parse(zlib.gunzipSync(bytes).toString("utf-8"));
  }
  return JSON.parse(init.body instanceof Blob ? await init.body.text() : (init.body as string));
};

const installFakeServer = (handler?: (call: Call, attempt: number) => Response | undefined) => {
  const calls: Call[] = [];
  const attempts = new Map<string, number>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit) => {
      const call: Call = { path, body: await readBody(init), headers: init.headers as Record<string, string> };
      calls.push(call);
      const attempt = (attempts.get(path) ?? 0) + 1;
      attempts.set(path, attempt);
      const custom = handler?.(call, attempt);
      if (custom) return custom;
      if (path === "/api/upload/blobs") {
        return json(200, { blobs: call.body.files.map((f: any) => ({ path: f.path, sha: sha(f.path.length) })) });
      }
      if (path === "/api/upload/commit") return json(200, { commit: { sha: "c0ffee", html_url: "https://github.com/o/r/commit/c0ffee" } });
      return json(404, { message: "unexpected path " + path });
    })
  );
  return calls;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("uploadToGitHub (batched)", () => {
  it("makes no request before the first batch: blobs per batch, then a single commit", async () => {
    const calls = installFakeServer();
    // 3 files of ~1.5 MB base64 each: 4 MB batches fit two files, so two batches.
    const files = [file("a.bin", 1_500_000), file("b.bin", 1_500_000), file("c.bin", 1_500_000)];

    const commit = await uploadToGitHub("o", "r", files, "msg", vi.fn());

    expect(calls.map((c) => c.path)).toEqual(["/api/upload/blobs", "/api/upload/blobs", "/api/upload/commit"]);
    expect(calls[0].body.files.map((f: any) => f.path)).toEqual(["a.bin", "b.bin"]);
    expect(calls[1].body.files.map((f: any) => f.path)).toEqual(["c.bin"]);
    // The commit gets only {path, sha}: file contents are never sent twice.
    expect(calls[2].body).toEqual({
      owner: "o",
      repo: "r",
      commitMessage: "msg",
      entries: files.map((f) => ({ path: f.path, sha: sha(f.path.length) })),
    });
    expect(commit.sha).toBe("c0ffee");
  });

  it("sends small text files with the commit and never as blobs", async () => {
    const calls = installFakeServer();
    const files = [textFile("index.js", "console.log(1)\n"), binFile("logo.png"), textFile("src/a.ts", "export {}\n")];

    await uploadToGitHub("o", "r", files, "msg", vi.fn());

    expect(calls.map((c) => c.path)).toEqual(["/api/upload/blobs", "/api/upload/commit"]);
    expect(calls[0].body.files.map((f: any) => f.path)).toEqual(["logo.png"]);
    expect(calls[1].body.entries).toEqual(
      expect.arrayContaining([
        { path: "index.js", content: "console.log(1)\n" },
        { path: "src/a.ts", content: "export {}\n" },
        { path: "logo.png", sha: sha("logo.png".length) },
      ])
    );
    expect(calls[1].body.entries).toHaveLength(3);
  });

  it("needs only the commit request when every file is small text", async () => {
    const calls = installFakeServer();
    const onProgress = vi.fn();

    await uploadToGitHub("o", "r", [textFile("a.txt", "a"), textFile("b.txt", "b")], "msg", onProgress);

    expect(calls.map((c) => c.path)).toEqual(["/api/upload/commit"]);
    expect(onProgress.mock.calls.at(-1)).toEqual(["Finalizing...", 2, 2]);
  });

  it("gzips the blob batches and the commit", async () => {
    const calls = installFakeServer();
    await uploadToGitHub("o", "r", [binFile("a.bin", 1000)], "msg", vi.fn());

    expect(calls[0].headers["Content-Encoding"]).toBe("gzip"); // blobs
    expect(calls[1].headers["Content-Encoding"]).toBe("gzip"); // commit
  });

  it("sends the same JSON when browser gzip is unavailable", async () => {
    vi.stubGlobal("CompressionStream", undefined);
    const calls = installFakeServer();
    const files = [binFile("a.bin", 1000)];
    await uploadToGitHub("o", "r", files, "msg", vi.fn());

    expect(calls[0].headers["Content-Encoding"]).toBeUndefined();
    expect(calls[0].body).toEqual({ owner: "o", repo: "r", files });
    expect(calls[1].headers["Content-Encoding"]).toBeUndefined();
    expect(calls[1].body.entries).toEqual([{ path: "a.bin", sha: sha("a.bin".length) }]);
  });

  it("reports progress from 0 to total/total, never going backwards", async () => {
    installFakeServer();
    const onProgress = vi.fn();
    const files = [binFile("a"), binFile("b"), textFile("c.txt", "c")];

    await uploadToGitHub("o", "r", files, "msg", onProgress);

    const steps = onProgress.mock.calls.map(([, current]) => current as number);
    const total = onProgress.mock.calls[0][2] as number;
    expect(total).toBe(2 + 2); // two blob files, plus the commit and its finish
    expect(onProgress.mock.calls[0]).toEqual(["Uploading files (0/2)...", 0, total]);
    expect([...steps].sort((x, y) => x - y)).toEqual(steps);
    expect(onProgress.mock.calls.at(-1)).toEqual(["Finalizing...", total, total]);
  });

  it("retries a blobs batch after a gateway error, since repeating a batch is harmless", async () => {
    const calls = installFakeServer((call, attempt) =>
      call.path === "/api/upload/blobs" && attempt === 1 ? json(503, { message: "Bad gateway" }) : undefined
    );

    await uploadToGitHub("o", "r", [binFile("a.bin")], "msg", vi.fn());

    expect(calls.filter((c) => c.path === "/api/upload/blobs")).toHaveLength(2);
  });

  it("does not retry the commit, so a lost answer cannot become a second commit", async () => {
    const calls = installFakeServer((call) =>
      call.path === "/api/upload/commit" ? json(504, { message: "Gateway timeout" }) : undefined
    );

    await expect(uploadToGitHub("o", "r", [binFile("a.bin")], "msg", vi.fn())).rejects.toThrow(/gateway timeout/i);
    expect(calls.filter((c) => c.path === "/api/upload/commit")).toHaveLength(1);
  });

  it("stops and reports the server's message when a batch is rejected", async () => {
    const calls = installFakeServer((call) =>
      call.path === "/api/upload/blobs" ? json(400, { message: "One or more file paths are invalid." }) : undefined
    );

    await expect(uploadToGitHub("o", "r", [binFile("a.bin")], "msg", vi.fn())).rejects.toThrow(/paths are invalid/i);
    expect(calls.map((c) => c.path)).not.toContain("/api/upload/commit");
  });

  it("refuses to commit if the server did not confirm every file of a batch", async () => {
    const calls = installFakeServer((call) =>
      call.path === "/api/upload/blobs" ? json(200, { blobs: [] }) : undefined
    );

    await expect(uploadToGitHub("o", "r", [binFile("a.bin")], "msg", vi.fn())).rejects.toThrow(/did not confirm/i);
    expect(calls.map((c) => c.path)).not.toContain("/api/upload/commit");
  });
});
