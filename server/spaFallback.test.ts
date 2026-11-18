import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import { hasFileExtension } from "./spaFallback";
import { createApp } from "../server";

describe("hasFileExtension", () => {
  it("is true for asset and file paths", () => {
    for (const p of ["/assets/index-abc123.js", "/assets/x.css", "/favicon.ico", "/robots.txt", "/.well-known/security.txt", "/fonts/a.woff2"]) {
      expect(hasFileExtension(p), p).toBe(true);
    }
  });

  it("is false for app routes, including ones with a dot in a folder name", () => {
    for (const p of ["/", "/faq", "/how-it-works", "/auth/callback", "/v1.2/page", "/faq/"]) {
      expect(hasFileExtension(p), p).toBe(false);
    }
  });
});

describe("SPA fallback in production", () => {
  let dir: string;
  let app: Awaited<ReturnType<typeof createApp>>;
  const before = { env: process.env.NODE_ENV };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ztg-dist-"));
    const dist = path.join(dir, "dist");
    fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
    fs.mkdirSync(path.join(dist, "faq"), { recursive: true });
    fs.writeFileSync(path.join(dist, "index.html"), "<html>home</html>");
    fs.writeFileSync(path.join(dist, "200.html"), "<html>shell</html>");
    fs.writeFileSync(path.join(dist, "faq", "index.html"), "<html>faq</html>");
    fs.writeFileSync(path.join(dist, "assets", "app-1.js"), "console.log(1)");
    process.env.GITHUB_CLIENT_ID = "id";
    process.env.GITHUB_CLIENT_SECRET = "secret";
    process.env.APP_URL = "http://localhost:3000";
    process.env.SESSION_SECRET = "s";
    process.env.NODE_ENV = "production";
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    app = await createApp();
  });

  afterAll(() => {
    vi.restoreAllMocks();
    process.env.NODE_ENV = before.env;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("serves a file that exists", async () => {
    const res = await request(app).get("/assets/app-1.js");
    expect(res.status).toBe(200);
    expect(res.text).toContain("console.log(1)");
  });

  it("returns 404, not index.html, for a missing file", async () => {
    for (const p of ["/assets/gone-9.js", "/assets/gone-9.css", "/favicon.png", "/x/y.map"]) {
      const res = await request(app).get(p);
      expect(res.status, p).toBe(404);
      expect(res.text, p).not.toContain("<html>");
    }
  });

  it("does not let a 404 for a missing file be cached", async () => {
    const res = await request(app).get("/assets/gone-9.js");
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("still serves the page for routes: prerendered ones and unknown ones", async () => {
    const home = await request(app).get("/");
    expect(home.status).toBe(200);
    expect(home.text).toContain("home");
    const faq = await request(app).get("/faq");
    expect(faq.status).toBe(200);
    expect(faq.text).toContain("faq");
    const unknown = await request(app).get("/some/client/route");
    expect(unknown.status).toBe(200);
    expect(unknown.text).toContain("shell");
  });
});
