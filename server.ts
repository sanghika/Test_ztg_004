import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import zlib from "zlib";
import cookieParser from "cookie-parser";
import compression from "compression";
import rateLimit from "express-rate-limit";
import * as githubService from "./server/githubService";
import { createSessionData } from "./server/sessionData";
import { scanPrecompressed, sendPrecompressed, servePrecompressed } from "./server/precompressed";
import { hasFileExtension } from "./server/spaFallback";
import { readAuthConfig, readPort } from "./server/config";
import { findPublicPage, NOT_FOUND_PAGE, PRERENDER_ROUTES } from "./src/routes";

const TOKEN_COOKIE = "gh_session";
const DELETE_PERMISSION_COOKIE = "gh_delete_permission";
const tokenFingerprint = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

const canDeleteRepository = (req: express.Request, token: string): boolean =>
  req.signedCookies?.[DELETE_PERMISSION_COOKIE] === tokenFingerprint(token);
const oauthStateCookie = (state: string) => `oauth_state_${state}`;
const OAUTH_CALLBACK_PATH = "/auth/callback";
// A readable (NOT HttpOnly) companion to the session cookie. It holds only "1"
// and is never trusted for anything: it lets index.html and the client decide
// between the hero and a spinner before the first API call has answered. The real session
// is still the signed HttpOnly gh_session cookie, checked by requireAuth.
const SESSION_FLAG_COOKIE = "has_session";

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
    // That is one proxy. Put a CDN or another proxy in front of it and there
    // are two: set TRUST_PROXY_HOPS=2, otherwise every visitor behind the same
    // CDN edge appears to have the edge's IP and they all share one rate limit.
    // Never set it higher than the number of proxies that really are there: a
    // client can then put a made-up address in X-Forwarded-For.
    const hops = Number.parseInt(process.env.TRUST_PROXY_HOPS ?? "", 10);
    app.set("trust proxy", Number.isInteger(hops) && hops >= 1 ? hops : 1);
  }

  const { appOrigin, clientId, clientSecret, cookieSecret } = readAuthConfig(process.env);
  const redirectUri = appOrigin + OAUTH_CALLBACK_PATH;

  // Compresses JSON API responses and static assets (HTML/CSS/JS) on the
  // wire. /api/delete-paths streams newline-delimited JSON progress events and
  // relies on each res.write() reaching the client right away — compression
  // buffers output, which would turn that live progress UI into stalled,
  // chunky updates — so that route opts out. (The /api/upload/* routes answer
  // with one small JSON body each, so they compress like everything else.)
  //
  // Brotli quality is set here on purpose. The package's default is 4 (a
  // balanced speed/size), but Node's own default is 11, which takes over half a
  // second for a 300 KB file; pinning it keeps a future change of the package
  // default from turning every response into a CPU spike. The built site does
  // not go through this at all: scripts/precompress.mjs compresses it once at
  // quality 11 and servePrecompressed (below) sends those files.
  app.use(
    compression({
      brotli: { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } },
      filter: (req, res) => {
        if (req.path === "/api/delete-paths") return false;
        return compression.filter(req, res);
      },
    })
  );

  app.use(cookieParser(cookieSecret));

  // Basic security headers
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });

  app.use(["/api", OAUTH_CALLBACK_PATH], (_req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
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

  app.use(["/api/auth/url", "/auth/callback", "/api/logout"], authLimiter);
  app.use(["/api/me", "/api/bootstrap", "/api/repo-tree"], readLimiter);
  // "/api/repos" is dual-purpose (GET list / POST create), so it needs to pick
  // its limiter by method rather than being lumped into one blanket app.use.
  app.use("/api/repos", (req, res, next) => (req.method === "GET" ? readLimiter : writeLimiter)(req, res, next));
  // A push is one commit (which counts against writeLimiter, so the cap stays
  // "30 pushes per 15 minutes") plus one /blobs request per batch of files,
  // which is why /blobs gets its own, higher cap: a 50 MB ZIP is a few dozen
  // batches, and counting them against writeLimiter would allow barely one push
  // per window.
  const blobLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 400,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitHandler,
  });
  app.use("/api/upload/blobs", blobLimiter);
  app.use(["/api/upload/commit", "/api/delete-paths", "/api/repo"], writeLimiter);

  // --- Request body parsing --- //
  // Parsing runs AFTER the rate limiters, and the default cap is small: every
  // request that reaches this point may still be unauthenticated, and Node
  // parses a JSON body synchronously on the single event loop, so a big body
  // would stall every other request. Ordinary API calls (create repo, delete
  // repo) carry well under 1 KB, so 100 KB is generous.
  //
  // The two routes that legitimately carry large bodies are skipped here and
  // attach their own, larger parser AFTER requireAuth (see below), so an
  // unauthenticated or rate-limited request never gets its body buffered.
  const defaultJsonParser = express.json({ limit: "100kb" });
  const ownsItsBodyParser = new Set(["/api/upload/blobs", "/api/upload/commit", "/api/delete-paths"]);
  app.use((req, res, next) =>
    ownsItsBodyParser.has(req.path) ? next() : defaultJsonParser(req, res, next)
  );

  // The client sends files to /api/upload/blobs in batches of a few MB, so a
  // request normally stays small. The cap still has to fit the largest single
  // file, which cannot be split: src/lib/uploadLimits.ts allows a total of
  // MAX_TOTAL_UPLOAD_BYTES = 50MB of original bytes, and base64 (+~33%) plus
  // JSON wrapper overhead need real headroom above that. For a gzipped request
  // the limit applies to the DECOMPRESSED size, so a zip bomb cannot slip past it.
  const blobsJsonParser = express.json({ limit: "75mb" });
  // /api/upload/commit and /api/delete-paths send lists (paths, {path, sha}
  // pairs, and the text of small files, which the client keeps under about
  // 2 MB), but a large project can mean thousands of entries, which would not
  // fit in 100 KB.
  const pathListJsonParser = express.json({ limit: "5mb" });

  const sessionCookieBase = {
    secure: isProd,
    sameSite: "lax" as const,
    path: "/",
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days; the flag always lives exactly as long as the session
  };
  const setSessionFlag = (res: express.Response) => {
    res.cookie(SESSION_FLAG_COOKIE, "1", { ...sessionCookieBase, httpOnly: false });
  };
  const clearSessionFlag = (res: express.Response) => {
    res.clearCookie(SESSION_FLAG_COOKIE, { path: "/" });
  };
  const setSessionCookie = (res: express.Response, token: string, allowDelete: boolean) => {
    const privateCookie = { ...sessionCookieBase, httpOnly: true, signed: true };
    res.cookie(TOKEN_COOKIE, token, privateCookie);
    if (allowDelete) {
      res.cookie(DELETE_PERMISSION_COOKIE, tokenFingerprint(token), privateCookie);
    } else {
      res.clearCookie(DELETE_PERMISSION_COOKIE, { path: "/" });
    }
    setSessionFlag(res);
  };
  const clearSession = (res: express.Response) => {
    res.clearCookie(TOKEN_COOKIE, { path: "/" });
    res.clearCookie(DELETE_PERMISSION_COOKIE, { path: "/" });
    clearSessionFlag(res);
  };

  // Sessions created before the flag existed have gh_session but no has_session.
  // Without this they would look signed out on the next visit. Any page request
  // that carries a validly signed session cookie gets the flag; the Set-Cookie
  // on the document response is applied before index.html's inline script runs,
  // so that very load already sees it. A forged cookie fails signature
  // verification, so signedCookies[TOKEN_COOKIE] is false and nothing is set.
  app.use((req, res, next) => {
    if (
      (req.method === "GET" || req.method === "HEAD") &&
      !req.path.startsWith("/api/") &&
      !req.path.startsWith("/auth/") &&
      !path.extname(req.path) &&
      (req as any).signedCookies?.[TOKEN_COOKIE] &&
      req.cookies?.[SESSION_FLAG_COOKIE] !== "1"
    ) {
      setSessionFlag(res);
    }
    next();
  });

  // Auth middleware: reads the GitHub token from the signed, HttpOnly cookie.
  // The token is never sent to or readable by client-side JS.
  const requireAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const token = (req as any).signedCookies?.[TOKEN_COOKIE];
    if (!token) {
      // A leftover flag (session expired, secret rotated) would send the page
      // into a spinner on every visit, so a 401 retires it.
      if (req.cookies?.[SESSION_FLAG_COOKIE]) clearSessionFlag(res);
      return res.status(401).json({ message: "Not authenticated." });
    }
    (req as any).ghToken = token;
    next();
  };

  // --- OAuth --- //

  // Revoke only this token. Deleting the entire OAuth app grant would also
  // disconnect other tokens the account uses on other devices.
  const revokeGitHubToken = async (token: string): Promise<void> => {
    const credentials = Buffer.from(clientId + ":" + clientSecret).toString("base64");
    const response = await fetch("https://api.github.com/applications/" + encodeURIComponent(clientId) + "/token", {
      method: "DELETE",
      headers: {
        "Authorization": "Basic " + credentials,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ access_token: token }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    // GitHub returns 404 for a token that has already been revoked.
    if (response.status !== 204 && response.status !== 404) {
      throw new Error("GitHub could not revoke the token.");
    }
    sessionData.invalidate(token);
  };

  app.get("/api/auth/url", (req, res) => {
    const allowDelete = req.query.intent === "delete-repo";
    const currentToken = req.signedCookies?.[TOKEN_COOKIE];
    if (allowDelete && typeof currentToken !== "string") {
      return res.status(401).json({ message: "Connect to GitHub before authorizing repository deletion." });
    }
    // The state value is generated server-side and bound to a signed,
    // HttpOnly cookie rather than trusted from the client. /auth/callback
    // validates the returned state against this cookie before exchanging
    // the code, which prevents an attacker from tricking a victim's browser
    // into completing an OAuth flow initiated with the attacker's own code
    // (login CSRF / session fixation).
    const state = crypto.randomBytes(16).toString("hex");
    // Each attempt has a separate cookie so simultaneous tabs can complete
    // in any order, even when both requested their URLs at the same time.
    const stateValue = allowDelete ? state + ":" + tokenFingerprint(currentToken) : state;
    res.cookie(oauthStateCookie(state), stateValue, {
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      signed: true,
      path: OAUTH_CALLBACK_PATH,
      maxAge: 1000 * 60 * 10, // 10 minutes; only needs to survive the redirect round trip
    });
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: allowDelete ? "repo delete_repo" : "repo",
      state,
    });
    const authUrl = `https://github.com/login/oauth/authorize?${params.toString()}`;
    res.json({ url: authUrl });
  });

  app.get(["/auth/callback", "/auth/callback/"], async (req, res) => {
    const code = req.query.code;
    const state = req.query.state;
    if (typeof state !== "string" || !/^[0-9a-f]{32}$/.test(state)) {
      return res.status(400).send("Invalid or expired authentication request. Please try signing in again.");
    }
    const cookieName = oauthStateCookie(state);
    const stateValue = req.signedCookies?.[cookieName];
    const currentToken = req.signedCookies?.[TOKEN_COOKIE];
    const upgradeToken = typeof currentToken === "string" && stateValue === state + ":" + tokenFingerprint(currentToken)
      ? currentToken : null;
    if (stateValue === state || upgradeToken !== null) {
      res.clearCookie(cookieName, { path: OAUTH_CALLBACK_PATH });
    } else if (req.signedCookies?.oauth_state === state) {
      // Let an attempt started before a deploy finish with its old cookie.
      res.clearCookie("oauth_state", { path: "/" });
    } else {
      return res.status(400).send("Invalid or expired authentication request. Please try signing in again.");
    }

    if (req.query.error === "access_denied") {
      return res.status(400).type("text/plain").send("GitHub authorization was canceled. You can close this window.");
    }
    if (typeof code !== "string" || !code) {
      return res.status(400).send("No code provided.");
    }

    try {
      const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
        })
      });

      const tokenData = await tokenResponse.json() as { access_token?: string; scope?: string };
      const token = tokenData.access_token;

      if (typeof token === "string" && token) {
        if (upgradeToken !== null) {
          if (typeof tokenData.scope !== "string" || !tokenData.scope.split(/[,\s]+/).includes("delete_repo")) {
            return res.status(403).type("text/plain").send("GitHub did not grant repository deletion access. You can close this window and keep using ZiptoGit.");
          }
          if (token !== upgradeToken) {
            const [previous, upgraded] = await Promise.all([
              githubService.fetchUser(upgradeToken),
              githubService.fetchUser(token),
            ]);
            if (previous.login.toLowerCase() !== upgraded.login.toLowerCase()) {
              return res.status(403).type("text/plain").send("Use the same GitHub account that is connected to ZiptoGit.");
            }
            await revokeGitHubToken(upgradeToken);
          }
        }
        // The token is set as an HttpOnly cookie the browser can never read via JS,
        // and is never included in the postMessage payload sent to the opener window.
        setSessionCookie(res, token, upgradeToken !== null);
        res.send(`
          <html>
            <body>
              <script>
                if (window.opener) {
                  try {
                    window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS', state: ${JSON.stringify(state)} }, ${JSON.stringify(appOrigin)});
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
        res.status(400).type("text/plain").send("GitHub did not complete the authorization. Close this window and try again.");
      }
    } catch {
      res.status(502).type("text/plain").send("Could not complete GitHub authorization. Close this window and try again.");
    }
  });

  app.post("/api/logout", async (req, res) => {
    const token = req.signedCookies?.[TOKEN_COOKIE];
    try {
      if (typeof token === "string") await revokeGitHubToken(token);
    } catch {
      return res.status(502).json({ message: "Could not disconnect from GitHub. Try again." });
    }
    clearSession(res);
    res.json({ ok: true });
  });

  // The user and the repository list, cached for a short time per session
  // (see server/sessionData.ts).
  const sessionData = createSessionData(githubService);

  // --- Authenticated GitHub proxy routes --- //
  // GitHub API calls run on the server using the token from the HttpOnly cookie.

  app.get("/api/me", requireAuth, async (req, res) => {
    try {
      res.json(await sessionData.getUser((req as any).ghToken));
    } catch (err: any) {
      handleGithubError(err, res);
    }
  });

  // Everything the dashboard needs to appear, in ONE request: the user plus the
  // first page of repositories, fetched from GitHub in parallel. The client
  // loads any further pages afterwards with GET /api/repos?page=N.
  app.get("/api/bootstrap", requireAuth, async (req, res) => {
    try {
      const token = (req as any).ghToken;
      res.json({ ...await sessionData.bootstrap(token), canDeleteRepository: canDeleteRepository(req, token) });
    } catch (err: any) {
      handleGithubError(err, res);
    }
  });

  // One page (100) of repositories: { repos: [{id, name, full_name}], nextPage }.
  app.get("/api/repos", requireAuth, async (req, res) => {
    try {
      const page = Number(req.query.page ?? 1);
      if (!Number.isInteger(page) || page < 1 || page > 1000) {
        return res.status(400).json({ message: "page must be a whole number from 1 to 1000." });
      }
      res.json(await sessionData.getRepoPage((req as any).ghToken, page));
    } catch (err: any) {
      handleGithubError(err, res);
    }
  });

  app.get("/api/repo-tree", requireAuth, async (req, res) => {
    try {
      const owner = req.query.owner as string;
      const repo = req.query.repo as string;
      if (!owner || !repo) return res.status(400).json({ message: "owner and repo are required." });
      // Optional: the default branch the client already has from the repo list.
      // Only a hint; a missing or wrong one falls back to asking GitHub.
      const branch = typeof req.query.branch === "string" && req.query.branch.length <= 255 ? req.query.branch : undefined;
      const result = await githubService.fetchRepoTree((req as any).ghToken, owner, repo, branch || undefined);
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
      sessionData.invalidate((req as any).ghToken); // the cached list no longer includes it
      res.status(201).json(githubService.toRepoSummary(repo));
    } catch (err: any) {
      handleGithubError(err, res);
    }
  });

  app.delete("/api/repo", requireAuth, async (req, res) => {
    try {
      const { owner, repo } = req.body || {};
      if (!owner || !repo) return res.status(400).json({ message: "owner and repo are required." });
      const token = (req as any).ghToken;
      if (!canDeleteRepository(req, token)) {
        return res.status(403).json({ message: "Authorize repository deletion with GitHub first." });
      }
      await githubService.deleteRepository(token, owner, repo);
      sessionData.invalidate((req as any).ghToken); // the cached list still includes it
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

  // --- Batched upload (see githubService.ts for the overall flow) --- //
  const isSha = (v: unknown): boolean => typeof v === "string" && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(v);

  app.post("/api/upload/blobs", requireAuth, blobsJsonParser, async (req, res) => {
    try {
      const { owner, repo, files } = req.body || {};
      if (!owner || !repo || !Array.isArray(files) || files.length === 0) {
        return res.status(400).json({ message: "owner, repo and files are required." });
      }
      if (files.some((f: any) => isUnsafePath(f?.path))) {
        return res.status(400).json({ message: "One or more file paths are invalid." });
      }
      if (files.some((f: any) => typeof f?.content !== "string")) {
        return res.status(400).json({ message: "Every file needs base64 content." });
      }
      const blobs = await githubService.createBlobs((req as any).ghToken, owner, repo, files);
      res.json({ blobs });
    } catch (err: any) {
      handleGithubError(err, res);
    }
  });

  // A tree entry is either a blob the client already created through /blobs
  // ({path, sha}) or a small text file whose text GitHub turns into a blob while
  // building the tree ({path, content}); never both, and never empty content
  // (GitHub treats an empty string as "no content given").
  const isValidTreeEntry = (e: any): boolean =>
    !isUnsafePath(e?.path) &&
    (isSha(e?.sha) !== (typeof e?.content === "string" && e.content.length > 0)) &&
    (e?.sha === undefined || e?.content === undefined);

  app.post("/api/upload/commit", requireAuth, pathListJsonParser, async (req, res) => {
    try {
      const { owner, repo, entries, commitMessage } = req.body || {};
      if (!owner || !repo || !Array.isArray(entries) || entries.length === 0) {
        return res.status(400).json({ message: "owner, repo and entries are required." });
      }
      if (entries.some((e: any) => isUnsafePath(e?.path))) {
        return res.status(400).json({ message: "One or more file paths are invalid." });
      }
      if (entries.some((entry) => entry.executable !== undefined && typeof entry.executable !== "boolean")) {
        return res.status(400).json({ message: "The executable flag must be true or false." });
      }
      if (!entries.every(isValidTreeEntry)) {
        return res.status(400).json({
          message: "Every entry needs either a valid blob SHA or non-empty text content.",
        });
      }
      const commit = await githubService.commitUpload(
        (req as any).ghToken,
        owner,
        repo,
        entries,
        typeof commitMessage === "string" && commitMessage ? commitMessage : "Upload files via ZiptoGit"
      );
      res.json({ commit });
    } catch (err: any) {
      handleGithubError(err, res);
    }
  });

  app.post("/api/delete-paths", requireAuth, pathListJsonParser, async (req, res) => {
    const { owner, repo, paths, commitMessage } = req.body || {};
    if (!owner || !repo || !Array.isArray(paths) || paths.length === 0) {
      return res.status(400).json({ message: "owner, repo and paths are required." });
    }
    if (paths.some((p: any) => isUnsafePath(p))) {
      return res.status(400).json({ message: "One or more paths are invalid." });
    }
    res.setHeader("Content-Type", "application/x-ndjson");
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
    const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    const requestId = err?.response?.headers?.["x-github-request-id"];
    // Octokit errors retain the original request options, including upload bodies.
    console.error("GitHub request failed", {
      method: res.req.method,
      route: res.req.route.path,
      status,
      ...(typeof requestId === "string" && /^[0-9a-f:]{1,80}$/i.test(requestId) ? { requestId } : {}),
    });
    if (status === 401) {
      // GitHub rejected the token (revoked or expired): the session is dead.
      // Clearing both cookies stops the flag from being re-issued for it.
      clearSession(res);
    }
    const message = err?.response?.data?.message || err?.message || "GitHub API error.";
    res.status(status).json({ message });
  }

  // Turns Express's default opaque error page for an oversized request body
  // into a clear JSON message the client already knows how to surface. This
  // is registered after the routes on purpose: the large-body parsers are
  // attached to individual routes, and an error handler only sees errors
  // raised by middleware registered before it.
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err && (err.type === "entity.too.large" || err.status === 413)) {
      const message = req.path === "/api/upload/blobs"
        ? "This upload is too large for the server to accept. Try removing large files from the ZIP."
        : "The request body is too large.";
      return res.status(413).json({ message });
    }
    next(err);
  });

  // Vite middleware for development (skipped in tests — API routes are all we need there)
  if (!isProd && !isTest) {
    // Imported here, not at the top of the file, so a production process never
    // loads Vite (or esbuild and the Tailwind native binaries behind it).
    const { createServer: createViteServer } = await import("vite");
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
    const cacheControlFor = (filePath: string): string =>
      filePath.includes(`${path.sep}assets${path.sep}`) ||
      // Self-hosted fonts keep their file names between builds, so the
      // version is part of the name (inter-4.0-latin-400.woff2). Changing
      // a font means adding a new file name, never editing one in place.
      filePath.includes(`${path.sep}fonts${path.sep}`)
        ? "public, max-age=31536000, immutable"
        : "no-cache";

    // `npm run build` also writes .br and .gz copies of the text files
    // (scripts/precompress.mjs). Those are sent as they are, instead of being
    // compressed again on every request. If dist/ has none (only `vite build`
    // was run) the index is empty and everything below works as before.
    const precompressed = scanPrecompressed(distPath);
    const sendOptions = { root: distPath, cacheControl: cacheControlFor };
    const shellFile = path.join(distPath, "index.html");
    const pageFiles = new Map(PRERENDER_ROUTES.map((page) => {
      const file = page.noindex ? path.join(distPath, "404.html") : path.join(distPath, page.path, "index.html");
      return [page.path, fs.existsSync(file) ? file : shellFile];
    }));
    const notFoundPage = pageFiles.get(NOT_FOUND_PAGE.path)!;

    const sendPage = (req: express.Request, res: express.Response, file: string) => {
      res.setHeader("Cache-Control", "no-cache");
      const copies = precompressed.byFile.get(file);
      const sendPlain = () => res.sendFile(file);
      if (!copies || !sendPrecompressed(req, res, copies, sendOptions, sendPlain)) sendPlain();
    };

    const redirectToPage = (req: express.Request, res: express.Response, canonicalPath: string) => {
      const queryAt = req.originalUrl.indexOf("?");
      const query = queryAt === -1 ? "" : req.originalUrl.slice(queryAt);
      return res.redirect(308, canonicalPath + query);
    };

    // Redirect direct links to prerendered HTML before static middleware serves them.
    app.use((req, res, next) => {
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      const separator = req.path.lastIndexOf("/");
      const directory = req.path.slice(0, separator);
      let filename: string;
      try {
        filename = decodeURIComponent(req.path.slice(separator + 1)).toLowerCase();
      } catch {
        return next();
      }
      if (!directory && (filename === "404.html" || filename === "200.html")) {
        return sendPage(req, res.status(404), notFoundPage);
      }
      if (filename !== "index.html") return next();
      const page = findPublicPage(directory || "/");
      if (!page) return next();
      return redirectToPage(req, res, page.path);
    });

    app.use(servePrecompressed(precompressed, sendOptions));

    app.use(
      express.static(distPath, {
        index: false,
        // /faq is a directory (dist/faq/index.html). Without this, static
        // answers /faq with a 301 to /faq/ instead of falling through to the
        // page handler below.
        redirect: false,
        setHeaders: (res, filePath) => {
          res.setHeader("Cache-Control", cacheControlFor(filePath));
        },
      })
    );

    app.get("*", (req, res) => {
      const page = findPublicPage(req.path);
      if (page) {
        if (req.path !== page.path) return redirectToPage(req, res, page.path);
        return sendPage(req, res, pageFiles.get(page.path)!);
      }
      // Keep missing asset and API responses out of the HTML error page.
      if (req.path.startsWith("/api/") || (hasFileExtension(req.path) && !/\.html?$/i.test(req.path))) {
        return res.status(404).setHeader("Cache-Control", "no-cache").type("text/plain").send("Not found");
      }
      return sendPage(req, res.status(404), notFoundPage);
    });
  }

  return app;
}

async function startServer() {
  const port = readPort(process.env.PORT);
  const app = await createApp();
  app.listen(port, "0.0.0.0", () => {
    console.log(`Server running on port ${port}`);
  });
}

if (process.env.NODE_ENV !== "test") {
  void startServer().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Server startup failed.");
    process.exitCode = 1;
  });
}
