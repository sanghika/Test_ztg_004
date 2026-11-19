import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import crypto from "crypto";
import request from "supertest";

// The GitHub calls are replaced; everything else (auth, routing, caching,
// trimming) is the real app.
const { mocks } = vi.hoisted(() => ({
  mocks: {
    fetchUser: vi.fn(),
    fetchRepositoryPage: vi.fn(),
    createRepository: vi.fn(),
    commitUpload: vi.fn(),
    deleteRepository: vi.fn(),
  },
}));
vi.mock("./server/githubService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./server/githubService")>()),
  ...mocks,
}));

import { createApp } from "./server";

const SECRET = "test_session_secret";
const signedCookie = (name: string, value: string) => {
  const sig = crypto.createHmac("sha256", SECRET).update(value).digest("base64").replace(/=+$/, "");
  return `${name}=${encodeURIComponent(`s:${value}.${sig}`)}`;
};
const session = (token = "tok") => [signedCookie("gh_session", token), "has_session=1"];

let app: Awaited<ReturnType<typeof createApp>>;

beforeAll(async () => {
  process.env.GITHUB_CLIENT_ID = "test_client_id";
  process.env.GITHUB_CLIENT_SECRET = "test_client_secret";
  process.env.APP_URL = "http://localhost:3000";
  process.env.SESSION_SECRET = SECRET;
});

beforeEach(async () => {
  Object.values(mocks).forEach((m) => m.mockReset());
  mocks.fetchUser.mockResolvedValue({ login: "octocat", avatar_url: "https://a/1" });
  mocks.fetchRepositoryPage.mockImplementation(async (_t: string, page: number) => ({
    repos: [{ id: page, name: `r${page}`, full_name: `octocat/r${page}` }],
    nextPage: page < 2 ? page + 1 : null,
  }));
  app = await createApp(); // a fresh app means a fresh cache
});

describe("GitHub error logging", () => {
  it("logs safe metadata without logging upload contents or GitHub error details", async () => {
    const content = "private file contents";
    mocks.commitUpload.mockRejectedValueOnce(Object.assign(new Error(content), {
      status: 403,
      request: { body: { content } },
      response: { headers: { "x-github-request-id": "ABC:123" }, data: { message: "Permission denied" } },
    }));

    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await request(app)
        .post("/api/upload/commit")
        .set("Cookie", session())
        .send({ owner: "octocat", repo: "r1", entries: [{ path: "a.txt", content }] });
      expect(res.status).toBe(403);
      expect(res.body.message).toBe("Permission denied");
      expect(log.mock.calls).toEqual([
        ["GitHub request failed", { method: "POST", route: "/api/upload/commit", status: 403, requestId: "ABC:123" }],
      ]);
    } finally {
      log.mockRestore();
    }
  });
});

describe("separate deletion authorization", () => {
  it.each([
    { login: "octocat", scope: "repo,delete_repo", expected: 200 },
    { login: "different-account", scope: "repo,delete_repo", expected: 403 },
    { login: "octocat", scope: "repo", expected: 403 },
  ])("sets deletion permission only for the same account with the granted scope ($expected)", async ({ login, scope, expected }) => {
    const browser = request.agent(app);
    const authorization = await browser.get("/api/auth/url?intent=delete-repo").set("Cookie", session().join("; "));
    const state = new URL(authorization.body.url).searchParams.get("state");
    mocks.fetchUser.mockImplementation(async (token: string) => ({ login: token === "tok" ? "octocat" : login, avatar_url: "" }));
    const upstream = vi.fn()
      .mockResolvedValueOnce({ json: async () => ({ access_token: "upgraded-token", scope }) })
      .mockResolvedValueOnce({ status: 204 });
    vi.stubGlobal("fetch", upstream);
    try {
      const response = await browser.get("/auth/callback?code=upgrade-code&state=" + state).set("Cookie", session().join("; "));
      expect(response.status).toBe(expected);
      const raw = response.headers["set-cookie"];
      const cookies = Array.isArray(raw) ? raw : [raw];
      const grant = cookies.find((cookie: string) => cookie?.startsWith("gh_delete_permission="));
      const token = cookies.find((cookie: string) => cookie?.startsWith("gh_session="));
      if (expected === 200) {
        expect(grant).toContain("HttpOnly");
        expect(token).toContain(encodeURIComponent("s:upgraded-token."));
        expect(upstream).toHaveBeenCalledTimes(2);
        expect(upstream.mock.calls[1][1].body).toBe(JSON.stringify({ access_token: "tok" }));
      } else {
        expect(grant).toBeUndefined();
        expect(token).toBeUndefined();
        expect(upstream).toHaveBeenCalledTimes(1);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("GET /api/bootstrap", () => {
  it("requires a session", async () => {
    expect((await request(app).get("/api/bootstrap")).status).toBe(401);
  });

  it("returns the user and the first page of repos in one response", async () => {
    const res = await request(app).get("/api/bootstrap").set("Cookie", session());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      user: { login: "octocat", avatar_url: "https://a/1" },
      repos: [{ id: 1, name: "r1", full_name: "octocat/r1" }],
      nextPage: 2,
      canDeleteRepository: false,
    });
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(mocks.fetchRepositoryPage).toHaveBeenCalledTimes(1);
    expect(mocks.fetchRepositoryPage).toHaveBeenCalledWith("tok", 1);
  });

  it("serves a second request from the cache instead of calling GitHub again", async () => {
    await request(app).get("/api/bootstrap").set("Cookie", session());
    await request(app).get("/api/bootstrap").set("Cookie", session());
    expect(mocks.fetchUser).toHaveBeenCalledTimes(1);
    expect(mocks.fetchRepositoryPage).toHaveBeenCalledTimes(1);
  });

  it("does not share cached data between different sessions", async () => {
    mocks.fetchUser.mockImplementation(async (t: string) => ({ login: `user-${t}`, avatar_url: "" }));
    const a = await request(app).get("/api/bootstrap").set("Cookie", session("a"));
    const b = await request(app).get("/api/bootstrap").set("Cookie", session("b"));
    expect(a.body.user.login).toBe("user-a");
    expect(b.body.user.login).toBe("user-b");
  });

  it("passes a GitHub 401 through (and does not cache it)", async () => {
    mocks.fetchUser.mockRejectedValueOnce(Object.assign(new Error("Bad credentials"), { status: 401 }));
    const res = await request(app).get("/api/bootstrap").set("Cookie", session());
    expect(res.status).toBe(401);
    const retry = await request(app).get("/api/bootstrap").set("Cookie", session());
    expect(retry.status).toBe(200);
  });
});

describe("GET /api/repos", () => {
  it("returns one trimmed page with the next page number", async () => {
    const res = await request(app).get("/api/repos?page=2").set("Cookie", session());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ repos: [{ id: 2, name: "r2", full_name: "octocat/r2" }], nextPage: null });
    expect(mocks.fetchRepositoryPage).toHaveBeenCalledWith("tok", 2);
  });

  it("defaults to page 1", async () => {
    await request(app).get("/api/repos").set("Cookie", session());
    expect(mocks.fetchRepositoryPage).toHaveBeenCalledWith("tok", 1);
  });

  it("rejects a page that is not a whole number from 1 to 1000", async () => {
    for (const bad of ["0", "-1", "abc", "1.5", "1001"]) {
      const res = await request(app).get(`/api/repos?page=${bad}`).set("Cookie", session());
      expect(res.status).toBe(400);
    }
    expect(mocks.fetchRepositoryPage).not.toHaveBeenCalled();
  });
});

describe("GET /api/me", () => {
  it("returns only login and avatar_url", async () => {
    const res = await request(app).get("/api/me").set("Cookie", session());
    expect(res.body).toEqual({ login: "octocat", avatar_url: "https://a/1" });
  });
});

describe("repository changes", () => {
  const fullGithubRepo = { id: 9, name: "new", full_name: "octocat/new", private: true, html_url: "https://github.com/octocat/new", owner: { login: "octocat" } };

  it("POST /api/repos returns only id, name and full_name", async () => {
    mocks.createRepository.mockResolvedValue(fullGithubRepo);
    const res = await request(app).post("/api/repos").set("Cookie", session()).send({ name: "new" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 9, name: "new", full_name: "octocat/new" });
  });

  it("creating a repo drops the cached list so the next load includes it", async () => {
    mocks.createRepository.mockResolvedValue(fullGithubRepo);
    await request(app).get("/api/bootstrap").set("Cookie", session());
    await request(app).post("/api/repos").set("Cookie", session()).send({ name: "new" });
    await request(app).get("/api/bootstrap").set("Cookie", session());
    expect(mocks.fetchRepositoryPage).toHaveBeenCalledTimes(2);
  });

  it("keeps full-repository deletion disabled without permission for the current token", async () => {
    const otherToken = crypto.createHash("sha256").update("other-token").digest("hex");
    const res = await request(app).delete("/api/repo")
      .set("Cookie", [...session(), signedCookie("gh_delete_permission", otherToken)])
      .send({ owner: "octocat", repo: "r1" });
    expect(res.status).toBe(403);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(mocks.deleteRepository).not.toHaveBeenCalled();
  });

  it("deleting a repo drops the cached list", async () => {
    mocks.deleteRepository.mockResolvedValue(undefined);
    await request(app).get("/api/bootstrap").set("Cookie", session());
    const fingerprint = crypto.createHash("sha256").update("tok").digest("hex");
    const res = await request(app).delete("/api/repo")
      .set("Cookie", [...session(), signedCookie("gh_delete_permission", fingerprint)])
      .send({ owner: "octocat", repo: "r1" });
    expect(res.status).toBe(200);
    await request(app).get("/api/bootstrap").set("Cookie", session());
    expect(mocks.fetchRepositoryPage).toHaveBeenCalledTimes(2);
  });

  it("logging out drops the cached data", async () => {
    await request(app).get("/api/bootstrap").set("Cookie", session());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 204 }));
    try {
      expect((await request(app).post("/api/logout").set("Cookie", session())).status).toBe(200);
    } finally {
      vi.unstubAllGlobals();
    }
    await request(app).get("/api/bootstrap").set("Cookie", session());
    expect(mocks.fetchUser).toHaveBeenCalledTimes(2);
  });
});
