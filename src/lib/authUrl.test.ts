import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prefetchAuthUrl, takeAuthUrl, resetAuthUrlCache, AUTH_URL_TTL_MS } from "./authUrl";

const okResponse = (url: string) => ({ ok: true, json: async () => ({ url }) }) as Response;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-16T10:00:00Z"));
  resetAuthUrlCache();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("authUrl", () => {
  it("fetches once when the URL was prefetched before the click", async () => {
    fetchMock.mockResolvedValue(okResponse("https://github.com/a"));
    prefetchAuthUrl();
    expect(await takeAuthUrl()).toBe("https://github.com/a");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/url");
  });

  it("fetches on the click when nothing was prefetched", async () => {
    fetchMock.mockResolvedValue(okResponse("https://github.com/b"));
    expect(await takeAuthUrl()).toBe("https://github.com/b");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not start a second request while one is on its way (hover, then focus, then press)", async () => {
    fetchMock.mockResolvedValue(okResponse("https://github.com/c"));
    prefetchAuthUrl();
    prefetchAuthUrl();
    prefetchAuthUrl();
    expect(await takeAuthUrl()).toBe("https://github.com/c");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses a prefetched URL only once: the next click gets a new one", async () => {
    fetchMock.mockResolvedValueOnce(okResponse("https://github.com/1")).mockResolvedValueOnce(okResponse("https://github.com/2"));
    prefetchAuthUrl();
    expect(await takeAuthUrl()).toBe("https://github.com/1");
    expect(await takeAuthUrl()).toBe("https://github.com/2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("drops a prefetched URL that has gone stale", async () => {
    fetchMock.mockResolvedValueOnce(okResponse("https://github.com/old")).mockResolvedValueOnce(okResponse("https://github.com/new"));
    prefetchAuthUrl();
    await vi.advanceTimersByTimeAsync(AUTH_URL_TTL_MS + 1);
    expect(await takeAuthUrl()).toBe("https://github.com/new");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("prefetches again after the old one went stale", async () => {
    fetchMock.mockResolvedValueOnce(okResponse("https://github.com/old")).mockResolvedValueOnce(okResponse("https://github.com/new"));
    prefetchAuthUrl();
    await vi.advanceTimersByTimeAsync(AUTH_URL_TTL_MS + 1);
    prefetchAuthUrl();
    expect(await takeAuthUrl()).toBe("https://github.com/new");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to a fresh request when the prefetch failed", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(okResponse("https://github.com/retry"));
    prefetchAuthUrl();
    expect(await takeAuthUrl()).toBe("https://github.com/retry");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a failed prefetch never throws by itself", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    expect(() => prefetchAuthUrl()).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("rejects when the server answers with an error and there is nothing to fall back on", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) } as Response);
    await expect(takeAuthUrl()).rejects.toThrow("Failed to get auth URL");
  });

  it("rejects a response that has no url", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
    await expect(takeAuthUrl()).rejects.toThrow("Failed to get auth URL");
  });
});
