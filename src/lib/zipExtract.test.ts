import { describe, it, expect, vi } from "vitest";
import JSZip from "jszip";
import { extractZipEntries } from "./zipExtract";
import { MAX_TOTAL_UPLOAD_BYTES } from "./uploadLimits";

// Keep the limits proportional to the test fixtures.
vi.mock("./uploadLimits", async (importOriginal) => ({
  ...await importOriginal<typeof import("./uploadLimits")>(),
  MAX_TOTAL_UPLOAD_BYTES: 96 * 1024,
}));

const makeZip = async (files: Record<string, string>): Promise<Uint8Array> => {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) zip.file(path, content);
  return zip.generateAsync({ type: "uint8array" });
};

const extract = async (data: Uint8Array) => {
  const out: { path: string; text: string }[] = [];
  await extractZipEntries(JSZip, data, {
    onFile: (path, base64) => out.push({ path, text: Buffer.from(base64, "base64").toString("utf-8") }),
    yieldBetweenBatches: false,
  });
  return out;
};

describe("extractZipEntries", () => {
  it("returns every file with its content as base64", async () => {
    const out = await extract(await makeZip({ "a.txt": "alpha", "src/b.txt": "beta" }));
    expect(out.find((f) => f.path === "a.txt")?.text).toBe("alpha");
    expect(out.find((f) => f.path === "src/b.txt")?.text).toBe("beta");
  });

  it("strips a single top-level folder that wraps every file", async () => {
    const out = await extract(await makeZip({ "proj/a.txt": "1", "proj/src/b.txt": "2" }));
    expect(out.map((f) => f.path).sort()).toEqual(["a.txt", "src/b.txt"]);
  });

  it("does not strip anything when the files do not share one root folder", async () => {
    const out = await extract(await makeZip({ "one/a.txt": "1", "two/b.txt": "2" }));
    expect(out.map((f) => f.path).sort()).toEqual(["one/a.txt", "two/b.txt"]);
  });

  it("skips macOS metadata", async () => {
    const out = await extract(await makeZip({ "a.txt": "1", "__MACOSX/._a.txt": "junk", ".DS_Store": "junk" }));
    expect(out.map((f) => f.path)).toEqual(["a.txt"]);
  });

  it("excludes generated output and repo metadata using the same rules as folder uploads", async () => {
    const out = await extract(await makeZip({
      "project/index.html": "index",
      "project/node_modules/dependency.js": "ignored",
      "project/.git/config": "ignored",
      "project/dist/bundle.js": "ignored",
      "project/images/Thumbs.db": "ignored",
      "project/images/photo.txt": "photo",
    }));
    expect(out.map((file) => file.path)).toEqual(["index.html", "images/photo.txt"]);
  });

  it("preserves bytes across chunk boundaries and writes Base64 padding only at the end", async () => {
    const zip = new JSZip();
    const bytes = Uint8Array.from({ length: 54_321 }, (_, i) => i % 256);
    zip.file("binary.dat", bytes);
    const data = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    const files: string[] = [];
    await extractZipEntries(JSZip, data, {
      yieldBetweenBatches: false,
      onFile: (_path, base64) => files.push(base64),
    });
    expect(files).toEqual([Buffer.from(bytes).toString("base64")]);
  });

  it("pauses an entry as soon as it exceeds the remaining upload budget", async () => {
    const zip = new JSZip();
    zip.file("first.txt", "x".repeat(MAX_TOTAL_UPLOAD_BYTES / 2));
    zip.file("second.txt", "y".repeat(MAX_TOTAL_UPLOAD_BYTES));
    zip.file("third.txt", "z");
    const data = await zip.generateAsync({ type: "uint8array", compression: "STORE" });
    const loaded = await JSZip.loadAsync(data);
    const second = loaded.file("second.txt") as JSZip.JSZipObject & {
      internalStream(type: "uint8array"): JSZip.JSZipStreamHelper<Uint8Array>;
    };
    const stream = second.internalStream("uint8array");
    const pause = vi.spyOn(stream, "pause");
    const processed = vi.fn();
    stream.on("data", processed);
    const secondStream = vi.spyOn(second, "internalStream").mockReturnValue(stream);
    const load = vi.spyOn(JSZip, "loadAsync").mockResolvedValueOnce(loaded);
    const onFile = vi.fn();
    try {
      await expect(extractZipEntries(JSZip, data, { onFile, yieldBetweenBatches: false }))
        .rejects.toThrow(/total upload limit/);
      expect(onFile.mock.calls.map(([file]) => file)).toEqual(["first.txt"]);
      expect(pause).toHaveBeenCalledOnce();
      const observedBytes = processed.mock.calls.reduce((size, [chunk]) => size + chunk.length, 0);
      expect(observedBytes).toBeLessThan(MAX_TOTAL_UPLOAD_BYTES);
    } finally {
      load.mockRestore();
      secondStream.mockRestore();
      pause.mockRestore();
    }
  });

  it("rejects an archive with no files in it", async () => {
    const zip = new JSZip();
    zip.folder("only-a-folder");
    const data = await zip.generateAsync({ type: "uint8array" });
    let caught: any;
    try { await extract(data); } catch (e) { caught = e; }
    expect(caught.message).toBe("This ZIP doesn't contain any files to upload.");
  });
});
