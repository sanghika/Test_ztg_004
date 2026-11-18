import { describe, it, expect, vi } from "vitest";
import { createSessionData } from "./sessionData";

const repo = (id: number) => ({ id, name: `r${id}`, full_name: `me/r${id}` });

const setup = () => {
  const service = {
    fetchUser: vi.fn(async (token: string) => ({ login: `user-of-${token}`, avatar_url: "" })),
    fetchRepositoryPage: vi.fn(async (token: string, page: number) => ({
      repos: [repo(page * 10)],
      nextPage: page < 3 ? page + 1 : null,
    })),
  };
  return { service, data: createSessionData(service) };
};

describe("sessionData.bootstrap", () => {
  it("returns the user and only the first page of repos, with the next page number", async () => {
    const { data, service } = setup();
    expect(await data.bootstrap("tok")).toEqual({
      user: { login: "user-of-tok", avatar_url: "" },
      repos: [repo(10)],
      nextPage: 2,
    });
    expect(service.fetchRepositoryPage).toHaveBeenCalledTimes(1);
  });

  it("starts both GitHub calls before either has finished", async () => {
    const order: string[] = [];
    let releaseUser!: () => void;
    const data = createSessionData({
      fetchUser: () => new Promise((res) => { order.push("user:start"); releaseUser = () => res({ login: "u", avatar_url: "" }); }),
      fetchRepositoryPage: async () => { order.push("repos:start"); return { repos: [], nextPage: null }; },
    });
    const pending = data.bootstrap("tok");
    await Promise.resolve();
    expect(order).toEqual(["user:start", "repos:start"]); // repos did not wait for the user
    releaseUser();
    await pending;
  });

  it("fails if either call fails, and caches nothing from the failure", async () => {
    const { data, service } = setup();
    service.fetchUser.mockRejectedValueOnce(Object.assign(new Error("Bad credentials"), { status: 401 }));
    await expect(data.bootstrap("tok")).rejects.toMatchObject({ status: 401 });
    await expect(data.bootstrap("tok")).resolves.toBeDefined();
  });
});

describe("sessionData caching", () => {
  it("serves repeat calls from the cache", async () => {
    const { data, service } = setup();
    await data.bootstrap("tok");
    await data.bootstrap("tok");
    await data.getRepoPage("tok", 1);
    expect(service.fetchUser).toHaveBeenCalledTimes(1);
    expect(service.fetchRepositoryPage).toHaveBeenCalledTimes(1);
  });

  it("caches each page separately", async () => {
    const { data, service } = setup();
    await data.getRepoPage("tok", 1);
    await data.getRepoPage("tok", 2);
    await data.getRepoPage("tok", 2);
    expect(service.fetchRepositoryPage).toHaveBeenCalledTimes(2);
  });

  it("never shares data between sessions", async () => {
    const { data } = setup();
    const a = await data.bootstrap("token-a");
    const b = await data.bootstrap("token-b");
    expect(a.user.login).toBe("user-of-token-a");
    expect(b.user.login).toBe("user-of-token-b");
  });

  it("expires after the TTL", async () => {
    let t = 0;
    const service = {
      fetchUser: vi.fn(async () => ({ login: "u", avatar_url: "" })),
      fetchRepositoryPage: vi.fn(async () => ({ repos: [], nextPage: null })),
    };
    const data = createSessionData(service, 45_000, 500, () => t);
    await data.bootstrap("tok");
    t = 44_999;
    await data.bootstrap("tok");
    expect(service.fetchUser).toHaveBeenCalledTimes(1);
    t = 45_001;
    await data.bootstrap("tok");
    expect(service.fetchUser).toHaveBeenCalledTimes(2);
  });

  it("invalidate() drops that session's entries and leaves other sessions alone", async () => {
    const { data, service } = setup();
    await data.bootstrap("tok-a");
    await data.bootstrap("tok-b");
    data.invalidate("tok-a");
    await data.bootstrap("tok-a");
    await data.bootstrap("tok-b");
    expect(service.fetchUser).toHaveBeenCalledTimes(3); // a twice, b once
  });
});
