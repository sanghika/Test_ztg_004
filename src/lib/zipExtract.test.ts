import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { extractZipEntries } from "./zipExtract";

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

  it("rejects an archive with no files in it", async () => {
    const zip = new JSZip();
    zip.folder("only-a-folder");
    const data = await zip.generateAsync({ type: "uint8array" });
    let caught: any;
    try { await extract(data); } catch (e) { caught = e; }
    expect(caught.message).toBe("This ZIP doesn't contain any files to upload.");
  });
});
