import { describe, it, expect } from "vitest";
import { estimateBytesFromBase64, checkUploadSize, MAX_TOTAL_UPLOAD_BYTES, MAX_SINGLE_FILE_BYTES } from "./uploadLimits";
import type { ExtractedFile } from "./github";

describe("estimateBytesFromBase64", () => {
  it("estimates the correct decoded size for known inputs", () => {
    // "hello world" is 11 bytes -> base64 "aGVsbG8gd29ybGQ=" (1 padding char)
    const b64 = Buffer.from("hello world", "utf-8").toString("base64");
    expect(estimateBytesFromBase64(b64)).toBe(11);
  });

  it("handles double-padded base64 correctly", () => {
    // "hi" is 2 bytes -> base64 "aGk=" -> actually single padding; use "h" (1 byte) for double padding
    const b64 = Buffer.from("h", "utf-8").toString("base64"); // "aA=="
    expect(b64.endsWith("==")).toBe(true);
    expect(estimateBytesFromBase64(b64)).toBe(1);
  });

  it("returns 0 for an empty string", () => {
    expect(estimateBytesFromBase64("")).toBe(0);
  });

  it("scales roughly linearly with input size", () => {
    const bigText = "x".repeat(1_000_000); // 1MB of raw text
    const b64 = Buffer.from(bigText, "utf-8").toString("base64");
    const estimated = estimateBytesFromBase64(b64);
    expect(estimated).toBe(1_000_000);
  });
});

const makeFile = (path: string, sizeBytes: number): ExtractedFile => {
  // Build a base64 string that decodes to approximately sizeBytes.
  const raw = "a".repeat(sizeBytes);
  return { path, content: Buffer.from(raw, "utf-8").toString("base64") };
};

describe("checkUploadSize", () => {
  it("passes for a small, normal set of files", () => {
    const files = [makeFile("a.txt", 1000), makeFile("b.txt", 2000)];
    const result = checkUploadSize(files);
    expect(result.ok).toBe(true);
  });

  it("rejects a single file over the per-file limit", () => {
    const files = [makeFile("huge.bin", MAX_SINGLE_FILE_BYTES + 1024)];
    const result = checkUploadSize(files);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("huge.bin");
    expect(result.error).toContain("per-file limit");
  });

  it("rejects when the combined total exceeds the overall limit even if no single file does", () => {
    const perFile = Math.floor(MAX_TOTAL_UPLOAD_BYTES / 3) + 1024;
    const files = [
      makeFile("a.bin", perFile),
      makeFile("b.bin", perFile),
      makeFile("c.bin", perFile),
    ];
    // Each individual file is well under MAX_SINGLE_FILE_BYTES.
    for (const f of files) {
      expect(estimateBytesFromBase64(f.content)).toBeLessThan(MAX_SINGLE_FILE_BYTES);
    }
    const result = checkUploadSize(files);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("total upload limit");
  });

  it("passes when right at the boundary (just under the limit)", () => {
    const files = [makeFile("a.bin", MAX_TOTAL_UPLOAD_BYTES - 10_000)];
    const result = checkUploadSize(files);
    expect(result.ok).toBe(true);
  });

  it("passes for an empty file list", () => {
    expect(checkUploadSize([]).ok).toBe(true);
  });
});
