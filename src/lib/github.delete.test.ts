import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteRepoPaths } from "./github";

afterEach(() => vi.unstubAllGlobals());

describe.each(["streaming", "buffered"])("%s delete responses", (mode) => {
  const mockResponse = (body: string) => {
    const response = new Response(body, { headers: { "Content-Type": "application/x-ndjson" } });
    if (mode === "buffered") Object.defineProperty(response, "body", { value: null });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  };

  it.each([
    "",
    '{"status":"Deleting"}\n',
    '{"done":true,"commit":{}}\n',
  ])("does not treat an incomplete response as success", async (body) => {
    mockResponse(body);
    await expect(deleteRepoPaths("owner", "repo", ["file.txt"], "Delete file"))
      .rejects.toThrow("Connection closed before the operation finished.");
  });

  it("reports a final server error", async () => {
    mockResponse('{"done":true,"error":"GitHub did not accept the change"}\n');
    await expect(deleteRepoPaths("owner", "repo", ["file.txt"], "Delete file"))
      .rejects.toThrow("GitHub did not accept the change");
  });

  it("returns the confirmed commit, including without a final newline", async () => {
    mockResponse('{"status":"Committing"}\n{"done":true,"commit":{"sha":"test-commit"}}');
    const onProgress = vi.fn();
    await expect(deleteRepoPaths("owner", "repo", ["file.txt"], "Delete file", onProgress))
      .resolves.toEqual({ sha: "test-commit" });
    expect(onProgress).toHaveBeenCalledWith("Committing");
  });
});
