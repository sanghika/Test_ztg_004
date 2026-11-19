export const SITE_ORIGIN = "https://ziptogit.in";

export const HOME_HEADING = "Upload a ZIP file to GitHub";
export const HOME_TITLE = "ZiptoGit - Push ZIP Archives Directly to GitHub";
export const HOME_DESCRIPTION = "Upload a ZIP archive or, on desktop, a project folder. Push the files to GitHub from your browser without installing Git.";

// Shown in the tab as "<title> | ZiptoGit".
export const PAGE_TITLES = {
  "/how-it-works": "How to upload a ZIP to GitHub",
  "/faq": "GitHub ZIP uploads: limits, permissions and pricing",
  "/privacy": "Privacy policy",
  "/terms": "Terms of service",
  "/contact": "Contact us",
} as const;

export const PAGE_DESCRIPTIONS: Record<keyof typeof PAGE_TITLES, string> = {
  "/how-it-works": "Learn how to connect GitHub, upload a ZIP or a project folder, and commit the files to your repository from your browser.",
  "/faq": "Find out what you can upload to GitHub with ZiptoGit, how much it costs, and which permissions it requests for public and private repositories.",
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
