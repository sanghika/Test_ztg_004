<div align="center">
  <img width="1200" alt="ZiptoGit Banner" src="https://res.cloudinary.com/dhxupweze/image/upload/v1781201096/social_ibkkyg.png" />
</div>

# ZiptoGit

Push ZIP archives directly to GitHub repositories without Git CLI.

## Features

- Upload ZIP files
- Extract automatically
- Push directly to GitHub
- GitHub OAuth login
- Manage (browse/delete) existing repo files & folders
- Delete an entire repository (with confirmation)
- Automatic secret scanning/redaction before push
- Mobile friendly
- No Git commands required

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `GITHUB_CLIENT_ID` | Yes | GitHub OAuth App client ID |
| `GITHUB_CLIENT_SECRET` | Yes | GitHub OAuth App client secret |
| `APP_URL` | Yes | Public HTTPS origin such as `https://ziptogit.in`. Register that origin plus `/auth/callback` as the GitHub OAuth App callback. Local production tests can use an HTTP loopback origin. |
| `SESSION_SECRET` | In production | Dedicated random signing secret, separate from `GITHUB_CLIENT_SECRET`. Generate one with `openssl rand -hex 32` and keep it stable across deployments. |
| `PORT` | No | Listening port supplied by the hosting service. Defaults to `3000`. |
| `TRUST_PROXY_HOPS` | No | How many proxies sit in front of the app in production (default `1`: the host's load balancer). Set `2` if you add a CDN such as Cloudflare in front of it, so rate limits still see each visitor's own IP. Never set it higher than the real number of proxies |
| `VITE_GA_MEASUREMENT_ID` | No | GA4 measurement ID (`G-…`). Read at **build** time (`npm run build`), not at runtime, so set it where the build runs. Unset, or not a valid `G-…` ID: no analytics script is loaded and no event is sent. When set, Google Analytics loads after the page has loaded, in production builds only |

**Security note:** the browser stores the GitHub access token in a signed HttpOnly session cookie that page scripts cannot read. All GitHub API calls run through the server (`server/githubService.ts`). If you're upgrading from an older version of this app, existing users will need to disconnect and reconnect their GitHub account once, both to migrate off client-stored tokens and to grant the `delete_repo` OAuth scope used by the delete-repository feature.

## Build and run

Run `npm ci` and `npm run build`. Set the production environment variables on your hosting service and start the app with `NODE_ENV=production npm start`. The server bundle and its source map live in `dist-server/`. Publish only `dist/` as browser assets.

Production startup rejects missing OAuth settings or a missing signing secret. If you previously relied on the OAuth secret to sign sessions, adding a dedicated signing secret will require existing users to reconnect once.

Run `npm run lint` for strict TypeScript and ESLint checks and `npm test` for the automated suite. The lint tools support Node 20.19+, 22.13+, or 24+. Run `npm run test:browser` with Python Playwright and Chromium installed and a local production server. Set `ZTG_TEST_ORIGIN` if it listens at an origin other than `http://localhost:3000`. GitHub requests in those browser tests use fixtures.

## Core Web Vitals

Production builds with `VITE_GA_MEASUREMENT_ID` configured sample 10% of document visits. The `web_vital` GA4 event reports LCP and INP in milliseconds and CLS as a unitless score. The event includes the entry route (an allowlisted public path), viewport size class, and whether the session cookie hint was present at entry. A client-side route change belongs to the same document visit. An INP sample requires a qualifying interaction.

To inspect event parameters in GA4 reports, register `metric_name`, `metric_rating`, `entry_route`, `entry_session`, and `viewport_class` as event-scoped custom dimensions. For a 75th-percentile report in the GA4 BigQuery export, use the latest `metric_value` per `metric_id`, then group by metric and the dimensions of interest. This counts a visit's updated measurement once.

## First paint

`npm run build` prerenders the home page (signed-out hero) and the content pages (`/how-it-works`, `/faq`, `/privacy`, `/terms`, `/contact`) to static HTML, so the page's `<h1>` is in the HTML itself and paints without waiting for JS or an API call.

- `vite build` builds the client; `vite build --ssr` builds `src/entry-server.tsx`; `scripts/prerender.mjs` writes `dist/index.html`, `dist/<page>/index.html` and `dist/404.html` for unknown page URLs. Pages and their titles/descriptions are listed in `src/routes.ts`.
- `server.ts` serves those files; the browser hydrates them (`src/main.tsx`). Anything rendered during prerender must not read `window`/`document`/`localStorage` while rendering, and must render the same on first client render as on the server (see `useTheme` and `useMediaQuery` in `src/App.tsx`).
- **`has_session` cookie.** Next to the HttpOnly `gh_session` cookie the server sets a readable `has_session=1`. It holds no secret and grants nothing; it only tells the page whether to show the hero straight away (no flag) or a spinner (flag). With the flag, an inline script in `index.html` starts `GET /api/bootstrap` immediately, in parallel with the JS download, and `fetchBootstrap()` reuses that request. A 401 or logout clears the flag. Sessions created before this existed get the flag on their next page load.
- **Dashboard data.** `GET /api/bootstrap` returns the user and the first page of up to 100 repositories, fetched from GitHub in parallel. **Load more repositories** requests one additional page with `GET /api/repos?page=N`. Responses carry only what the UI uses (`login`, `avatar_url`, `id`, `name`, `full_name`, and `default_branch`). The server caches results per session for 45 seconds (`server/sessionData.ts`, keyed by a hash of the token) and clears them when you create or delete a repository or log out.
- **Bundle size.** Opening the ZIP picker or dragging a recognized ZIP over the drop zone starts loading the extractor. Direct drops load it on demand. Push loads the secret scanner, and Manage files loads the file tree alongside the tree request. Anything new that is heavy and not needed for the first paint should follow the same pattern. `npm run analyze` opens a treemap of the client bundle (it fetches `vite-bundle-visualizer` with npx, so it is not a project dependency); check it after changing imports.
- **Heavy work runs in Web Workers.** Reading a ZIP (`src/lib/workers/extract.worker.ts`, logic in `src/lib/zipExtract.ts`) and scanning files for secrets (`src/lib/workers/scan.worker.ts`, logic in `src/lib/secretScannerCore.ts`) happen off the main thread. Workers are one-shot (started per job, terminated afterwards, so their memory is released). Small scans (under 256 KB of text) and browsers without Workers use the same code on the main thread in short slices. The scanner skips files over 5 MiB (`MAX_SCAN_BYTES`) and lists them for review before asking for confirmation to push. Files containing a NUL byte count as binary and are not scanned. Keep the worker files free of DOM access and of imports from `github.ts`, so their bundles stay small.
- **Compression.** `scripts/precompress.mjs` (run by `npm run build`, after the prerender) writes a Brotli (quality 11) and a gzip copy next to every text file in `dist/`, and `server/precompressed.ts` sends those, picking Brotli when the client accepts it. Quality 11 makes the main bundle about 14% smaller than the quality-4 Brotli the `compression` middleware uses, but takes over half a second per file, so it is done once at build time, not per request. API responses and anything without a copy still go through `compression` (Brotli quality pinned to 4). To check: `curl -s -o /dev/null -D - -H "Accept-Encoding: br" https://ziptogit.in/assets/<file>.js` should show `Content-Encoding: br`. Use a GET like this: `curl -I` sends HEAD, which `compression` never compresses, so it only shows the header for files served from the pre-compressed copies.
- **Manage files tree.** `GET /api/repo-tree` takes the default branch from the repository list (`?branch=`) and lists the files with a single GitHub request (`git.getTree` accepts a branch name); without it, or if the branch is stale, it asks GitHub for the default branch first. A very large repository comes back with `truncated: true` (GitHub's limit is 100,000 entries or 7 MB) and the page says the list is partial. Deleting never works from a partial list: it walks the tree folder by folder instead. The tree itself is windowed (`src/components/RepoFileTree.tsx`): only the rows in view are in the DOM.
- For local development, use `npm run dev`. To preview the production build locally, set the production settings with `APP_URL=http://localhost:3000` and run `npm start`.
- Screenshots for checking layout by eye: with the app running, `npm run screenshots` (see `scripts/screenshots.mjs`). Playwright is deliberately not a dependency; the script says how to install it for one run.

## Live Demo

https://ziptogit.in

follow developer on Instagram - https://www.instagram.com/_dipesh_08
