// Single source of truth for the pages that are prerendered to static HTML.
// Used by App.tsx (the <title> each page sets) and by the prerender step
// (scripts/prerender.mjs, through src/entry-server.tsx), so the title in the
// static HTML and the title React sets after hydration can never differ.
//
// "/" is prerendered too, but keeps the title and description that
// index.html already has, so it has no entry here.

export const SITE_ORIGIN = "https://ziptogit.in";

// The home page's <title>. It is the one in index.html, which is what the
// prerendered "/" ships with, and App.tsx sets it again when the home screen
// mounts (so coming back to "/" from another page restores it). The two must
// stay identical: src/routes.test.ts compares them.
export const HOME_TITLE = "ZiptoGit - Push ZIP Archives Directly to GitHub";

// Shown in the tab as "<title> | ZiptoGit".
export const PAGE_TITLES = {
  "/how-it-works": "How it works",
  "/faq": "FAQ",
  "/privacy": "Privacy policy",
  "/terms": "Terms of service",
  "/contact": "Contact us",
} as const;

export const PAGE_DESCRIPTIONS: Record<keyof typeof PAGE_TITLES, string> = {
  "/how-it-works": "How ZiptoGit works: connect GitHub, upload your ZIP, and push the extracted files to your repository in one commit.",
  "/faq": "Answers to common questions about ZiptoGit: security, cost, and using it with private repositories.",
  "/privacy": "ZiptoGit privacy policy: what information we collect, how your GitHub token is kept, and which third-party services we use.",
  "/terms": "ZiptoGit terms of service: acceptance of terms, responsible use, and disclaimer of warranties.",
  "/contact": "Contact ZiptoGit for questions, feedback or support.",
};

export type PrerenderRoute = {
  path: string;
  /** Full <title> text. Omitted for "/", which keeps index.html's own. */
  title?: string;
  description?: string;
};

export const PRERENDER_ROUTES: PrerenderRoute[] = [
  { path: "/" },
  ...(Object.keys(PAGE_TITLES) as (keyof typeof PAGE_TITLES)[]).map((path) => ({
    path,
    title: `${PAGE_TITLES[path]} | ZiptoGit`,
    description: PAGE_DESCRIPTIONS[path],
  })),
];
