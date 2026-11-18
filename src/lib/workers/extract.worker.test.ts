import JSZip from "jszip";
import { expect, it, vi } from "vitest";
import type { ExtractedFile } from "../github";

it("batches small files, sends a large file separately, and flushes the last partial batch", async () => {
  const zip = new JSZip();
  for (let i = 0; i < 33; i++) zip.file(`small-${i}.txt`, String(i));
  zip.file("large.txt", "x".repeat(256 * 1024));
  zip.file("last.txt", "last");
  const file = await zip.generateAsync({ type: "uint8array" });
  const postMessage = vi.fn();
  const scope = { postMessage, setImmediate, onmessage: undefined as ((event: { data: { file: Uint8Array } }) => Promise<void>) | undefined };
  vi.stubGlobal("self", scope);
  try {
    await import("./extract.worker");
    await scope.onmessage!({ data: { file } });
    const messages = postMessage.mock.calls.map(([message]) => message);
    expect(messages[0].type).toBe("ready");
    expect(messages.at(-1).type).toBe("done");
    const batches: ExtractedFile[][] = messages.filter(m => m.type === "files").map(m => m.files);
    expect(batches.map(batch => batch.length)).toEqual([32, 1, 1, 1]);
    expect(batches.flat().map(entry => entry.path)).toEqual(Object.keys(zip.files));
    expect(batches.at(-1)![0].content).toBe(Buffer.from("last").toString("base64"));
  } finally {
    vi.unstubAllGlobals();
  }
});
