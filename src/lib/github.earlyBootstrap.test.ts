import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fetchBootstrap } from "./github";

// index.html starts GET /api/bootstrap before the bundle loads and leaves the
// outcome on window.__ZTG_BOOT__; the first fetchBootstrap() takes it instead
// of asking again.

const early = (ok: boolean, status: number, body: any) => Promise.resolve({ ok, status, body });
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;
let win: { __ZTG_BOOT__?: Promise<any> };

beforeEach(() => {
  win = {};
  vi.stubGlobal("window", win);
  fetchMock = vi.fn(async () => jsonResponse({ user: { login: "from-network" }, repos: [], nextPage: null }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchBootstrap with an early /api/bootstrap", () => {
  it("returns the early result and makes no request of its own", async () => {
    win.__ZTG_BOOT__ = early(true, 200, { user: { login: "early" }, repos: [], nextPage: null });
    expect(await fetchBootstrap()).toEqual({ user: { login: "early" }, repos: [], nextPage: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses it only once; the next call asks the server again", async () => {
    win.__ZTG_BOOT__ = early(true, 200, { user: { login: "early" }, repos: [], nextPage: null });
    await fetchBootstrap();
    expect(win.__ZTG_BOOT__).toBeUndefined();
    expect(await fetchBootstrap()).toEqual({ user: { login: "from-network" }, repos: [], nextPage: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/bootstrap");
  });

  it("turns an early 401 into the same error apiFetch throws, without a second request", async () => {
    win.__ZTG_BOOT__ = early(false, 401, { message: "Not authenticated." });
    await expect(fetchBootstrap()).rejects.toMatchObject({ status: 401, message: "Not authenticated." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to a generic message when the early error had no JSON body", async () => {
    win.__ZTG_BOOT__ = early(false, 502, null);
    await expect(fetchBootstrap()).rejects.toMatchObject({ status: 502, message: "Request failed (502)" });
  });

  it("retries normally if the early request failed at the network level", async () => {
    win.__ZTG_BOOT__ = Promise.reject(new TypeError("Failed to fetch"));
    expect(await fetchBootstrap()).toEqual({ user: { login: "from-network" }, repos: [], nextPage: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("fetchBootstrap without an early request", () => {
  it("just asks the server", async () => {
    expect(await fetchBootstrap()).toEqual({ user: { login: "from-network" }, repos: [], nextPage: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still throws a status-carrying error on 401", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: "Not authenticated." }, 401));
    await expect(fetchBootstrap()).rejects.toMatchObject({ status: 401 });
  });
});
