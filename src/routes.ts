export const SITE_ORIGIN = "https://ziptogit.in";

export const HOME_TITLE = "ZiptoGit - Push ZIP Archives Directly to GitHub";
export const HOME_DESCRIPTION = "Securely upload your AI Studio ZIP exports and push their extracted contents directly to your GitHub repositories without needing a local Git environment or CLI.";

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
  title: string;
  description: string;
  noindex?: boolean;
};

const publicPages: PrerenderRoute[] = [
  { path: "/", title: HOME_TITLE, description: HOME_DESCRIPTION },
  ...(Object.keys(PAGE_TITLES) as (keyof typeof PAGE_TITLES)[]).map((path) => ({
    path,
    title: `${PAGE_TITLES[path]} | ZiptoGit`,
    description: PAGE_DESCRIPTIONS[path],
  })),
];

export const NOT_FOUND_PAGE: PrerenderRoute = {
  path: "/404",
  title: "Page not found | ZiptoGit",
  description: "The page you requested could not be found.",
  noindex: true,
};

export const PRERENDER_ROUTES = [...publicPages, NOT_FOUND_PAGE];

export function findPublicPage(pathname: string): PrerenderRoute | undefined {
  try {
    const path = pathname.replace(/\/+$/, "").split("/")
      .map((segment) => decodeURIComponent(segment).replaceAll("/", "%2F"))
      .join("/").toLowerCase() || "/";
    return publicPages.find((page) => page.path === path);
  } catch {
    return undefined;
  }
}
