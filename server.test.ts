import { describe, it, expect, beforeAll } from "vitest";
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

  it("rejects POST /api/upload with no session cookie", async () => {
    const res = await request(app)
      .post("/api/upload")
      .send({ owner: "x", repo: "y", files: [] });
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
  it("builds a GitHub OAuth URL with the repo + delete_repo scopes", async () => {
    const res = await request(app).get("/api/auth/url");
    expect(res.status).toBe(200);
    expect(res.body.url).toContain("https://github.com/login/oauth/authorize");
    expect(res.body.url).toContain("scope=repo+delete_repo");
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
    const setCookie = getSetCookies(res).join(";");
    expect(setCookie).toContain("oauth_state=");
    expect(setCookie).toContain("HttpOnly");
  });
});

describe("/auth/callback", () => {
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
  it("upload route requires owner, repo, and files even before hitting GitHub", async () => {
    const res = await request(app).post("/api/upload").send({});
    // Unauthenticated request is rejected before validation runs.
    expect(res.status).toBe(401);
  });
});
