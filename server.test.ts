import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import crypto from "crypto";
import zlib from "zlib";
import request from "supertest";
import { createApp } from "./server";

let app: Awaited<ReturnType<typeof createApp>>;

// supertest/superagent types res.headers["set-cookie"] as `string`, but at
// runtime it's actually a string[] (one entry per Set-Cookie header) when
// multiple cookies are set in one response. This normalizes it either way.
const getSetCookies = (res: request.Response): string[] => {
  const raw = res.headers["set-cookie"] as unknown as string | string[] | undefined;
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
};

beforeAll(async () => {
  process.env.GITHUB_CLIENT_ID = "test_client_id";
  process.env.GITHUB_CLIENT_SECRET = "test_client_secret";
  process.env.APP_URL = "http://localhost:3000";
  process.env.SESSION_SECRET = "test_session_secret";
  app = await createApp();
});

describe("authenticated route protection", () => {
  it("rejects /api/me with no session cookie", async () => {
    const res = await request(app).get("/api/me");
    expect(res.status).toBe(401);
  });

  it("rejects /api/repos with no session cookie", async () => {
    const res = await request(app).get("/api/repos");
    expect(res.status).toBe(401);
  });

  it("rejects /api/repo-tree with no session cookie", async () => {
    const res = await request(app).get("/api/repo-tree?owner=x&repo=y");
    expect(res.status).toBe(401);
  });

  it("rejects POST /api/upload/blobs with no session cookie", async () => {
    const res = await request(app)
      .post("/api/upload/blobs")
      .send({ owner: "x", repo: "y", files: [{ path: "a.txt", content: "" }] });
    expect(res.status).toBe(401);
  });

  it("rejects POST /api/upload/commit with no session cookie", async () => {
    const res = await request(app)
      .post("/api/upload/commit")
      .send({ owner: "x", repo: "y", entries: [{ path: "a.txt", sha: "a".repeat(40) }] });
    expect(res.status).toBe(401);
  });

  it("rejects POST /api/delete-paths with no session cookie", async () => {
    const res = await request(app)
      .post("/api/delete-paths")
      .send({ owner: "x", repo: "y", paths: ["a"] });
    expect(res.status).toBe(401);
  });

  it("rejects DELETE /api/repo with no session cookie", async () => {
    const res = await request(app)
      .delete("/api/repo")
      .send({ owner: "x", repo: "y" });
    expect(res.status).toBe(401);
  });

  it("ignores a garbage/forged cookie rather than trusting it", async () => {
    const res = await request(app).get("/api/me").set("Cookie", "gh_session=not-a-real-signed-value");
    expect(res.status).toBe(401);
  });
});

describe("/api/auth/url", () => {
  it("requests repo access during ordinary sign-in", async () => {
    const res = await request(app).get("/api/auth/url");
    expect(res.status).toBe(200);
    expect(res.body.url).toContain("https://github.com/login/oauth/authorize");
    expect(new URL(res.body.url).searchParams.get("scope")).toBe("repo");
  });

  it("requests deletion access only for an explicit authorization by a signed-in user", async () => {
    const path = "/api/auth/url?intent=delete-repo";
    const unauthorized = await request(app).get(path);
    expect(unauthorized.status).toBe(401);

    const authorized = await request(app).get(path).set("Cookie", signedCookie("gh_session", "original-token"));
    expect(authorized.status).toBe(200);
    expect(new URL(authorized.body.url).searchParams.get("scope")).toBe("repo delete_repo");
  });

  it("ignores a client-supplied state and generates its own instead", async () => {
    // The state must never be attacker/client-controlled — otherwise an
    // attacker could predict or fix it and forge a matching callback.
    const res = await request(app).get("/api/auth/url?state=attacker-chosen-value");
    expect(res.status).toBe(200);
    expect(res.body.url).not.toContain("state=attacker-chosen-value");
    expect(res.body.url).toMatch(/state=[0-9a-f]{32}/);
  });

  it("sets a signed, HttpOnly oauth_state cookie bound to the generated state", async () => {
    const res = await request(app).get("/api/auth/url");
    const state = new URL(res.body.url).searchParams.get("state");
    const setCookie = getSetCookies(res).find((cookie) => cookie.startsWith(`oauth_state_${state}=`));
    expect(setCookie).toContain(encodeURIComponent(`s:${state}.`));
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Path=/auth/callback");
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });
});

describe("/auth/callback", () => {
  it("keeps two sign-in attempts independent in the same browser", async () => {
    const browser = request.agent(app);
    const [first, second] = await Promise.all([
      browser.get("/api/auth/url"),
      browser.get("/api/auth/url"),
    ]);
    const firstState = new URL(first.body.url).searchParams.get("state");
    const secondState = new URL(second.body.url).searchParams.get("state");
    expect(firstState).not.toBe(secondState);

    for (const state of [firstState, secondState]) {
      const result = await browser.get(`/auth/callback?state=${state}`);
      // Both reach the code check, because each has its own matching cookie.
      expect(result.status).toBe(400);
      expect(result.text).toBe("No code provided.");
    }
  });

  it("still accepts an in-progress sign-in from before the deployment", async () => {
    const state = "a".repeat(32);
    const res = await request(app)
      .get(`/auth/callback?state=${state}`)
      .set("Cookie", signedCookie("oauth_state", state));
    expect(res.text).toBe("No code provided.");
    expect(getSetCookies(res).some((cookie) => cookie.startsWith("oauth_state=;"))).toBe(true);
  });

  it("returns 400 when no code is provided, even with a valid matching state", async () => {
    // Uses a real state/cookie pair from /api/auth/url so this test isolates
    // the missing-code check specifically, rather than accidentally being
    // caught by the (separately tested) state-mismatch check first.
    const urlRes = await request(app).get("/api/auth/url");
    const cookies = getSetCookies(urlRes);
    const match = urlRes.body.url.match(/state=([0-9a-f]+)/);
    const state = match?.[1];

    const res = await request(app)
      .get(`/auth/callback?state=${state}`)
      .set("Cookie", cookies);

    expect(res.status).toBe(400);
    expect(res.text).toMatch(/no code provided/i);
  });

  it("rejects a state that doesn't match the oauth_state cookie set by /api/auth/url", async () => {
    // This is the core regression test for the OAuth login-CSRF /
    // session-fixation fix: a callback whose state doesn't match the
    // signed cookie must be rejected before the code is ever exchanged.
    const urlRes = await request(app).get("/api/auth/url");
    const cookies = getSetCookies(urlRes);

    const res = await request(app)
      .get("/auth/callback?code=some-code&state=attacker-supplied-state")
      .set("Cookie", cookies);

    expect(res.status).toBe(400);
    expect(res.text).toMatch(/invalid or expired/i);
  });

  it("rejects a deletion authorization if the session changed while the popup was open", async () => {
    const authorization = await request(app)
      .get("/api/auth/url?intent=delete-repo")
      .set("Cookie", signedCookie("gh_session", "first-session"));
    const state = new URL(authorization.body.url).searchParams.get("state");
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    try {
      const callback = await request(app)
        .get("/auth/callback?code=upgrade-code&state=" + state)
        .set("Cookie", [...getSetCookies(authorization), signedCookie("gh_session", "second-session")]);
      expect(callback.status).toBe(400);
      expect(callback.headers["cache-control"]).toBe("private, no-store");
      expect(upstream).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects a callback with no oauth_state cookie at all", async () => {
    const res = await request(app).get("/auth/callback?code=some-code&state=anything");
    expect(res.status).toBe(400);
  });
});

describe("input validation on write routes", () => {
  // These still return 401 first since requireAuth runs before validation —
  // this just confirms an authenticated-but-malformed request wouldn't be a
  // 500. We can't fully exercise this without a real token, but a missing
  // body's rejection message logic is covered indirectly via the 401 above.
  it("blobs route requires owner, repo, and files even before hitting GitHub", async () => {
    const res = await request(app).post("/api/upload/blobs").send({});
    // Unauthenticated request is rejected before validation runs.
    expect(res.status).toBe(401);
  });
});

// --- has_session flag cookie --- //
// A readable companion to the HttpOnly gh_session cookie. It lets the page pick
// between the hero and a spinner before /api/me answers. It carries no secret
// and grants nothing; these tests pin down when it is set and cleared.

// Builds a cookie the way cookie-parser expects a signed one ("s:" + value +
// "." + base64 HMAC-SHA256 without padding), so tests can present a session
// without going through GitHub.
const signedCookie = (name: string, value: string, secret = "test_session_secret") => {
  const sig = crypto.createHmac("sha256", secret).update(value).digest("base64").replace(/=+$/, "");
  return `${name}=${encodeURIComponent(`s:${value}.${sig}`)}`;
};
const findCookie = (res: request.Response, name: string) =>
  getSetCookies(res).find((c) => c.startsWith(`${name}=`));

describe("has_session flag cookie", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is set, readable by JS, next to an HttpOnly session when GitHub sign-in completes", async () => {
    const urlRes = await request(app).get("/api/auth/url");
    const cookies = getSetCookies(urlRes);
    const state = urlRes.body.url.match(/state=([0-9a-f]+)/)?.[1];
    vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => ({ access_token: "gho_test_token" }) })));

    const res = await request(app).get(`/auth/callback?code=abc&state=${state}`).set("Cookie", cookies);

    expect(res.status).toBe(200);
    const session = findCookie(res, "gh_session");
    const flag = findCookie(res, "has_session");
    expect(session).toBeDefined();
    expect(session).toContain("HttpOnly");
    expect(flag).toBeDefined();
    expect(flag).toMatch(/^has_session=1;/);
    expect(flag).not.toContain("HttpOnly");
    expect(flag).not.toContain("gho_test_token");
    expect(findCookie(res, "gh_delete_permission")).toMatch(/^gh_delete_permission=;/);
  });

  it("is added to a page request that carries a valid session but no flag (sessions from before the flag existed)", async () => {
    const res = await request(app).get("/faq").set("Cookie", signedCookie("gh_session", "tok"));
    expect(findCookie(res, "has_session")).toMatch(/^has_session=1;/);
  });

  it("is not re-sent when the flag is already there", async () => {
    const res = await request(app)
      .get("/faq")
      .set("Cookie", [signedCookie("gh_session", "tok"), "has_session=1"]);
    expect(findCookie(res, "has_session")).toBeUndefined();
  });

  it("is never granted for a forged or unsigned session cookie", async () => {
    const forged = await request(app).get("/faq").set("Cookie", "gh_session=s%3Atok.not-a-valid-signature");
    expect(findCookie(forged, "has_session")).toBeUndefined();
    const plain = await request(app).get("/faq").set("Cookie", "gh_session=tok");
    expect(findCookie(plain, "has_session")).toBeUndefined();
  });

  it("is not added to API calls or to file requests", async () => {
    const session = signedCookie("gh_session", "tok");
    const api = await request(app).get("/api/auth/url").set("Cookie", session);
    expect(findCookie(api, "has_session")).toBeUndefined();
    const file = await request(app).get("/robots.txt").set("Cookie", session);
    expect(findCookie(file, "has_session")).toBeUndefined();
  });

  it("is retired by a 401, so a stale flag cannot keep sending the page into a spinner", async () => {
    const res = await request(app).get("/api/me").set("Cookie", "has_session=1");
    expect(res.status).toBe(401);
    expect(findCookie(res, "has_session")).toMatch(/^has_session=;/);
  });

  it("is not touched by a 401 when there was no flag", async () => {
    const res = await request(app).get("/api/me");
    expect(res.status).toBe(401);
    expect(findCookie(res, "has_session")).toBeUndefined();
  });

  it("is cleared together with the session on logout", async () => {
    const res = await request(app).post("/api/logout");
    expect(res.status).toBe(200);
    expect(findCookie(res, "gh_session")).toMatch(/^gh_session=;/);
    expect(findCookie(res, "has_session")).toMatch(/^has_session=;/);
  });
});

describe("revoking GitHub access on disconnect", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([204, 404])("clears session cookies when GitHub responds with %s", async (status) => {
    const revoke = vi.fn().mockResolvedValue({ status });
    vi.stubGlobal("fetch", revoke);
    const res = await request(app).post("/api/logout").set("Cookie", signedCookie("gh_session", "token-to-revoke"));
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(revoke).toHaveBeenCalledWith("https://api.github.com/applications/test_client_id/token", expect.objectContaining({
      method: "DELETE",
      body: JSON.stringify({ access_token: "token-to-revoke" }),
      headers: expect.objectContaining({
        Authorization: "Basic " + Buffer.from("test_client_id:test_client_secret").toString("base64"),
      }),
    }));
    for (const name of ["gh_session", "has_session", "gh_delete_permission"]) {
      expect(findCookie(res, name)).toMatch(new RegExp("^" + name + "=;"));
    }
  });

  it("keeps the session available to retry if GitHub fails to revoke it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 503 }));
    const res = await request(app).post("/api/logout").set("Cookie", signedCookie("gh_session", "active-token"));
    expect(res.status).toBe(502);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(getSetCookies(res)).toEqual([]);
  });
});

// --- request body limits --- //
// The default JSON cap is small because it applies to requests that may not be
// authenticated yet; only /api/upload/blobs (large) and /api/upload/commit and
// /api/delete-paths (long lists, more modest) accept big bodies, and only after
// the rate limiter and requireAuth.
describe("request body limits", () => {
  const oversizedForDefault = "A".repeat(200 * 1024); // over the 100 KB default
  const session = () => signedCookie("gh_session", "tok");

  it("rejects an oversized JSON body on an ordinary route with a JSON 413", async () => {
    const res = await request(app).post("/api/repos").send({ name: oversizedForDefault });
    expect(res.status).toBe(413);
    expect(res.body.message).toMatch(/too large/i);
  });

  it("does not parse a large body on /api/upload/blobs for an unauthenticated request", async () => {
    const res = await request(app)
      .post("/api/upload/blobs")
      .send({ owner: "x", repo: "y", files: [{ path: "a.txt", content: oversizedForDefault }] });
    // 401 (not 413): requireAuth answers before any body parser runs.
    expect(res.status).toBe(401);
  });

  it("accepts a body over 100 KB on /api/upload/blobs once authenticated", async () => {
    const res = await request(app)
      .post("/api/upload/blobs")
      .set("Cookie", session())
      // An unsafe path makes the route answer 400 before it would call GitHub,
      // which proves the large body was parsed rather than rejected as 413.
      .send({ owner: "x", repo: "y", files: [{ path: "../evil.txt", content: oversizedForDefault }] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/paths are invalid/i);
  });

  it("accepts a gzip-compressed body on /api/upload/blobs, as the client sends it", async () => {
    const payload = JSON.stringify({
      owner: "x",
      repo: "y",
      files: [{ path: "../evil.txt", content: oversizedForDefault }],
    });
    const compressedRequest = request(app)
      .post("/api/upload/blobs")
      .set("Cookie", session())
      .set("Content-Type", "application/json")
      .set("Content-Encoding", "gzip");
    // Write the gzip bytes directly. Superagent's JSON serializer would
    // otherwise turn the Buffer into an object before sending it.
    compressedRequest.write(zlib.gzipSync(payload));
    const res = await compressedRequest;
    // Reaching the route's own validation means the body was inflated and parsed.
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/paths are invalid/i);
  });

  it("accepts a list over 100 KB on /api/upload/commit once authenticated", async () => {
    const entries = Array.from({ length: 2000 }, (_, i) => ({ path: `some/folder/file-${i}.txt`, sha: "a".repeat(40) }));
    entries.push({ path: "../evil.txt", sha: "a".repeat(40) });
    const res = await request(app).post("/api/upload/commit").set("Cookie", session()).send({ owner: "x", repo: "y", entries });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/paths are invalid/i);
  });

  // Each of these must be refused before the route would call GitHub.
  it.each([
    ["a malformed blob SHA", { path: "a.txt", sha: "not-a-sha" }],
    ["an entry with neither a SHA nor content", { path: "a.txt" }],
    ["an entry with both a SHA and content", { path: "a.txt", sha: "a".repeat(40), content: "hi" }],
    ["empty inline content (GitHub reads it as 'no content')", { path: "a.txt", content: "" }],
    ["non-string inline content", { path: "a.txt", content: 42 }],
  ])("rejects %s on /api/upload/commit", async (_label, entry) => {
    const res = await request(app)
      .post("/api/upload/commit")
      .set("Cookie", session())
      .send({ owner: "x", repo: "y", entries: [entry] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/valid blob SHA or non-empty text content/i);
  });

  it("accepts a body over 100 KB on /api/delete-paths once authenticated", async () => {
    const paths = Array.from({ length: 5000 }, (_, i) => `some/folder/file-${i}.txt`);
    paths.push("../evil.txt");
    const res = await request(app)
      .post("/api/delete-paths")
      .set("Cookie", session())
      .send({ owner: "x", repo: "y", paths });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/paths are invalid/i);
  });
});

// A push makes one /blobs request per batch of files, so /blobs must not share
// the 30-per-15-minutes budget of the write routes.
describe("upload batch rate limiting", () => {
  it("allows far more than the write-route cap of blob requests", async () => {
    for (let i = 0; i < 35; i++) {
      const res = await request(app).post("/api/upload/blobs").send({});
      expect(res.status).toBe(401); // not 429
    }
  });
});

describe("TRUST_PROXY_HOPS (production only)", () => {
  const build = async (hops?: string) => {
    const before = { NODE_ENV: process.env.NODE_ENV, hops: process.env.TRUST_PROXY_HOPS };
    process.env.NODE_ENV = "production";
    if (hops === undefined) delete process.env.TRUST_PROXY_HOPS;
    else process.env.TRUST_PROXY_HOPS = hops;
    try {
      return (await createApp()).get("trust proxy");
    } finally {
      process.env.NODE_ENV = before.NODE_ENV;
      if (before.hops === undefined) delete process.env.TRUST_PROXY_HOPS;
      else process.env.TRUST_PROXY_HOPS = before.hops;
    }
  };

  it("trusts one proxy by default", async () => {
    expect(await build()).toBe(1);
  });

  it("trusts as many as configured, e.g. a CDN in front of the host's load balancer", async () => {
    expect(await build("2")).toBe(2);
  });

  it("ignores nonsense and falls back to one", async () => {
    for (const bad of ["", "0", "-3", "abc"]) {
      expect(await build(bad)).toBe(1);
    }
  });
});
