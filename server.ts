import express from "express";
import path from "path";
import crypto from "crypto";
import cookieParser from "cookie-parser";
import compression from "compression";
import rateLimit from "express-rate-limit";
import { createServer as createViteServer } from "vite";
import * as githubService from "./server/githubService";

const TOKEN_COOKIE = "gh_session";
const OAUTH_STATE_COOKIE = "oauth_state";

/**
 * Builds and configures the Express app, without starting a listener.
 * Split out from startServer() so tests can exercise routes directly
 * (via supertest) without binding a real port.
 */
export async function createApp() {
  const app = express();

  app.disable('x-powered-by');

  const isProd = process.env.NODE_ENV === "production";
  const isTest = process.env.NODE_ENV === "test";
  if (isProd) {
    // Required for express-rate-limit (and secure cookies) to see the real
    // client IP when running behind Northflank's/Render's load balancer.
    app.set("trust proxy", 1);
  }

  if (!isTest && !process.env.SESSION_SECRET) {
    console.warn(
      "WARNING: SESSION_SECRET is not set. Falling back to GITHUB_CLIENT_SECRET to sign session cookies. " +
      "Set a dedicated SESSION_SECRET env var in production."
    );
  }
  const cookieSecret = process.env.SESSION_SECRET || process.env.GITHUB_CLIENT_SECRET || "dev-only-insecure-secret";

  // Compresses JSON API responses and static assets (HTML/CSS/JS) on the
  // wire. /api/upload and /api/delete-paths stream newline-delimited JSON
  // progress events and rely on each res.write() reaching the client right
  // away — compression buffers output, which would turn that live progress
  // UI into stalled, chunky updates — so those two routes opt out.
  app.use(
    compression({
      filter: (req, res) => {
        if (req.path === "/api/upload" || req.path === "/api/delete-paths") return false;
        return compression.filter(req, res);
      },
    })
  );

  app.use(cookieParser(cookieSecret));
  // Kept in sync with src/lib/uploadLimits.ts (MAX_TOTAL_UPLOAD_BYTES = 50MB
  // of original file bytes). Base64 (+~33%) and JSON wrapper overhead mean
  // the raw request body limit needs real headroom above that.
  app.use(express.json({ limit: "75mb" }));

  // Turns Express's default opaque error page for an oversized request body
  // into a clear JSON message the client already knows how to surface.
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err && (err.type === "entity.too.large" || err.status === 413)) {
      return res.status(413).json({
        message: "This upload is too large for the server to accept. Try removing large files from the ZIP.",
      });
    }
    next(err);
  });

  // Basic security headers
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });

  // --- Rate limiting --- //
  // Tuned per endpoint cost: OAuth/auth routes are cheap targets for abuse,
  // read endpoints are hit often during normal use, and write/destructive
  // endpoints (push, delete) are the most expensive and highest-stakes, so
  // they get the tightest caps.
  const rateLimitHandler = (req: express.Request, res: express.Response) => {
    res.status(429).json({ message: "Too many requests. Please slow down and try again shortly." });
  };

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitHandler,
  });

  const readLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitHandler,
  });

  const writeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitHandler,
  });

  app.use(["/api/auth/url", "/auth/callback"], authLimiter);
  app.use(["/api/me", "/api/repo-tree"], readLimiter);
  // "/api/repos" is dual-purpose (GET list / POST create), so it needs to pick
  // its limiter by method rather than being lumped into one blanket app.use.
  app.use("/api/repos", (req, res, next) => (req.method === "GET" ? readLimiter : writeLimiter)(req, res, next));
  app.use(["/api/upload", "/api/delete-paths", "/api/repo"], writeLimiter);

  const setSessionCookie = (res: express.Response, token: string) => {
    res.cookie(TOKEN_COOKIE, token, {
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      signed: true,
      path: "/",
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
    });
  };

  // Auth middleware: reads the GitHub token from the signed, HttpOnly cookie.
  // The token is never sent to or readable by client-side JS.
  const requireAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const token = (req as any).signedCookies?.[TOKEN_COOKIE];
    if (!token) {
      return res.status(401).json({ message: "Not authenticated." });
    }
    (req as any).ghToken = token;
    next();
  };

  // --- OAuth --- //

  app.get("/api/auth/url", (req, res) => {
    const redirectUri = `${process.env.APP_URL}/auth/callback`;
    // The state value is generated server-side and bound to a signed,
    // HttpOnly cookie rather than trusted from the client. /auth/callback
    // validates the returned state against this cookie before exchanging
    // the code, which prevents an attacker from tricking a victim's browser
    // into completing an OAuth flow initiated with the attacker's own code
    // (login CSRF / session fixation).
    const state = crypto.randomBytes(16).toString("hex");
    res.cookie(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      signed: true,
      path: "/",
      maxAge: 1000 * 60 * 10, // 10 minutes; only needs to survive the redirect round trip
    });
    const params = new URLSearchParams({
      client_id: process.env.GITHUB_CLIENT_ID || "",
      redirect_uri: redirectUri,
      scope: "repo delete_repo", // "repo" for read/write access; "delete_repo" is required to delete repositories
      state,
    });
    const authUrl = `https://github.com/login/oauth/authorize?${params.toString()}`;
    res.json({ url: authUrl });
  });

  app.get(["/auth/callback", "/auth/callback/"], async (req, res) => {
    const code = req.query.code as string;
    const state = (req.query.state as string) || "";

    const savedState = (req as any).signedCookies?.[OAUTH_STATE_COOKIE];
    res.clearCookie(OAUTH_STATE_COOKIE, { path: "/" });
    if (!savedState || savedState !== state) {
      return res.status(400).send("Invalid or expired authentication request. Please try signing in again.");
    }

    if (!code) {
      return res.status(400).send("No code provided.");
    }

    try {
      const redirectUri = `${process.env.APP_URL}/auth/callback`;
      const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify({
          client_id: process.env.GITHUB_CLIENT_ID,
          client_secret: process.env.GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: redirectUri,
        })
      });

      const tokenData = await tokenResponse.json() as { access_token?: string, error_description?: string };

      if (tokenData.access_token) {
        // The token is set as an HttpOnly cookie the browser can never read via JS,
        // and is never included in the postMessage payload sent to the opener window.
        setSessionCookie(res, tokenData.access_token);
        const safeState = state.replace(/'/g, "\\'");
        const targetOrigin = (process.env.APP_URL || "").replace(/'/g, "\\'");
        res.send(`
          <html>
            <body>
              <script>
                if (window.opener) {
                  try {
                    window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS', state: '${safeState}' }, '${targetOrigin}');
                    window.close();
                  } catch (e) {
                    window.location.href = '/';
                  }
                } else {
                  window.location.href = '/';
                }
              </script>
              <p>Authentication successful. You can close this window.</p>
            </body>
          </html>
        `);
      } else {
        res.status(400).send(`Authentication failed: ${tokenData.error_description || JSON.stringify(tokenData)}`);
      }
    } catch (error) {
      res.status(500).send(`Authentication error: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  });

  app.post("/api/logout", (req, res) => {
    res.clearCookie(TOKEN_COOKIE, { path: "/" });
    res.json({ ok: true });
  });

  // --- Authenticated GitHub proxy routes --- //
  // The client never holds the GitHub token; every GitHub API call is made
  // server-side using the token read from the HttpOnly session cookie.

  app.get("/api/me", requireAuth, async (req, res) => {
    try {
      const user = await githubService.fetchUser((req as any).ghToken);
      res.json(user);
    } catch (err: any) {
      handleGithubError(err, res);
    }
  });

  app.get("/api/repos", requireAuth, async (req, res) => {
    try {
      const repos = await githubService.fetchRepositories((req as any).ghToken);
      res.json(repos);
    } catch (err: any) {
      handleGithubError(err, res);
    }
  });

  app.get("/api/repo-tree", requireAuth, async (req, res) => {
    try {
      const owner = req.query.owner as string;
      const repo = req.query.repo as string;
      if (!owner || !repo) return res.status(400).json({ message: "owner and repo are required." });
      const result = await githubService.fetchRepoTree((req as any).ghToken, owner, repo);
      res.json(result);
    } catch (err: any) {
      handleGithubError(err, res);
    }
  });

  app.post("/api/repos", requireAuth, async (req, res) => {
    try {
      const { name, isPrivate } = req.body || {};
      if (!name || typeof name !== "string") {
        return res.status(400).json({ message: "A repository name is required." });
      }
      const repo = await githubService.createRepository((req as any).ghToken, name, !!isPrivate);
      res.status(201).json(repo);
    } catch (err: any) {
      handleGithubError(err, res);
    }
  });

  app.delete("/api/repo", requireAuth, async (req, res) => {
    try {
      const { owner, repo } = req.body || {};
      if (!owner || !repo) return res.status(400).json({ message: "owner and repo are required." });
      await githubService.deleteRepository((req as any).ghToken, owner, repo);
      res.json({ ok: true });
    } catch (err: any) {
      handleGithubError(err, res);
    }
  });

  // Mirrors the zip-slip filter already applied client-side in
  // extractZip() (src/lib/github.ts). The client-side check is only a UX
  // convenience — anyone hitting this API directly bypasses it entirely, so
  // the server must not trust `path` without re-validating it.
  const isUnsafePath = (p: unknown): boolean =>
    typeof p !== "string" || p.length === 0 ||
    p.includes("../") || p.includes("..\\") || p.startsWith("/");

  // Streams newline-delimited JSON progress events, ending with a final
  // {"done": true, ...} line, so the client can keep its progress UI.
  app.post("/api/upload", requireAuth, async (req, res) => {
    const { owner, repo, files, commitMessage } = req.body || {};
    if (!owner || !repo || !Array.isArray(files)) {
      return res.status(400).json({ message: "owner, repo and files are required." });
    }
    if (files.some((f: any) => isUnsafePath(f?.path))) {
      return res.status(400).json({ message: "One or more file paths are invalid." });
    }
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    try {
      const commit = await githubService.uploadToGitHub(
        (req as any).ghToken,
        owner,
        repo,
        files,
        commitMessage || "Upload files via ZiptoGit",
        (status, current, total) => {
          res.write(JSON.stringify({ status, current, total }) + "\n");
        }
      );
      res.write(JSON.stringify({ done: true, commit }) + "\n");
    } catch (err: any) {
      const message = err?.response?.data?.message || err?.message || "Upload failed.";
      res.write(JSON.stringify({ done: true, error: message }) + "\n");
    } finally {
      res.end();
    }
  });

  app.post("/api/delete-paths", requireAuth, async (req, res) => {
    const { owner, repo, paths, commitMessage } = req.body || {};
    if (!owner || !repo || !Array.isArray(paths) || paths.length === 0) {
      return res.status(400).json({ message: "owner, repo and paths are required." });
    }
    if (paths.some((p: any) => isUnsafePath(p))) {
      return res.status(400).json({ message: "One or more paths are invalid." });
    }
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    try {
      const commit = await githubService.deleteRepoPaths(
        (req as any).ghToken,
        owner,
        repo,
        paths,
        commitMessage || `Delete ${paths.length} item(s) via ZiptoGit`,
        (status) => {
          res.write(JSON.stringify({ status }) + "\n");
        }
      );
      res.write(JSON.stringify({ done: true, commit }) + "\n");
    } catch (err: any) {
      const message = err?.response?.data?.message || err?.message || "Delete failed.";
      res.write(JSON.stringify({ done: true, error: message }) + "\n");
    } finally {
      res.end();
    }
  });

  function handleGithubError(err: any, res: express.Response) {
    console.error(err);
    const status = err?.status && Number.isInteger(err.status) ? err.status : 500;
    const message = err?.response?.data?.message || err?.message || "GitHub API error.";
    res.status(status >= 400 && status < 600 ? status : 500).json({ message });
  }

  // Vite middleware for development (skipped in tests — API routes are all we need there)
  if (!isProd && !isTest) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else if (isProd) {
    const distPath = path.join(process.cwd(), "dist");
    // Vite fingerprints everything under /assets with a content hash, so those
    // files are safe to cache forever — a new build always gets new filenames.
    // index.html is NOT fingerprinted, so it must always be revalidated;
    // otherwise a browser (or an intermediary CDN) can keep serving a stale
    // index.html that points at JS/CSS chunks a later deploy has already
    // deleted from disk, which 404s on load and renders a blank white page
    // until the user does a hard refresh. Setting "no-cache" (not "no-store")
    // still lets the browser use a conditional GET / 304, so this costs
    // basically nothing on repeat visits while guaranteeing freshness.
    app.use(
      express.static(distPath, {
        index: false,
        setHeaders: (res, filePath) => {
          if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          } else {
            res.setHeader("Cache-Control", "no-cache");
          }
        },
      })
    );
    app.get("*", (req, res) => {
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  return app;
}

async function startServer() {
  const PORT = 3000;
  const app = await createApp();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

if (process.env.NODE_ENV !== "test") {
  startServer();
}
