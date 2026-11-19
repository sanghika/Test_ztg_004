import { Component, useState, useEffect, useLayoutEffect, useRef, useCallback, Fragment, Suspense, type ComponentType } from "react";
import { BrowserRouter, Routes, Route, Link, useLocation, useNavigationType } from "react-router-dom";
import { trackPageView } from "./lib/analytics";
import { findPublicPage, NOT_FOUND_PAGE, SITE_ORIGIN } from "./routes";
import { WEBSITE_SCHEMA_ID, websiteStructuredData } from "./siteStructuredData.mjs";
import { MAX_TOTAL_UPLOAD_BYTES, SECRET_SCAN_NOTE } from "./lib/uploadLimits";
import { Github, Sun, Moon, Menu, X } from "lucide-react";
import { CARD_EDGE, CTRL, StepBadge, T } from "./components/ui";

// --- Theme --- //
// Light or dark at every width. The first visit follows the OS setting
// (prefers-color-scheme); once someone uses the toggle their choice is stored
// and wins. index.html applies the same rule before first paint, so there is
// no light flash, and this hook keeps the `dark` class on <html> in sync.
const THEME_STORAGE_KEY = "ziptogit-theme";
type Theme = "dark" | "light";

function getStoredTheme(): Theme | null {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : null;
  } catch {
    return null; // storage blocked: fall back to the OS setting
  }
}

function getInitialTheme(): Theme {
  if (typeof window === "undefined") return "light";
  return getStoredTheme() ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}

function useTheme() {
  // Server and first client render must agree for hydration to attach to the
  // prerendered HTML, and the server cannot know the visitor's theme, so the
  // first render is always "light" and the real theme is adopted in a layout
  // effect (before paint). Nothing visual waits on this state: colours come
  // from the `dark` class index.html already put on <html>, and the toggle's
  // knob and icon use dark: variants. `ready` stops the first pass from
  // stripping that class.
  const [state, setState] = useState<{ theme: Theme; ready: boolean }>({ theme: "light", ready: false });
  const { theme, ready } = state;
  const setTheme = useCallback((next: Theme) => setState((s) => ({ ...s, theme: next })), []);

  useLayoutEffect(() => {
    setState({ theme: getInitialTheme(), ready: true });
  }, []);

  // useLayoutEffect so the class is applied before the browser paints.
  useLayoutEffect(() => {
    if (!ready) return;
    document.documentElement.classList.toggle("dark", theme === "dark");
    // Browser chrome (address bar on phones) matches the page colour, not a fixed one.
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#0b0f17" : "#eef1f6");
  }, [theme, ready]);

  // Follow the OS while nobody has chosen explicitly.
  useEffect(() => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (getStoredTheme()) return;
      setTheme(mql.matches ? "dark" : "light");
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [setTheme]);

  const toggleTheme = useCallback(() => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* storage blocked: the choice still applies for this visit */
    }
  }, [theme, setTheme]);

  return { theme, toggleTheme };
}

function ThemeToggle({ theme, onToggle, className = "" }: { theme: Theme; onToggle: () => void; className?: string }) {
  const isDark = theme === "dark";
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      aria-pressed={isDark}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      // The track is 32px tall; the ::after extends the tappable area to 48px
      // vertically without changing how it looks. The track is the `field`
      // colour in both themes so the knob stands off it at 3.6:1 (white knob,
      // light) and 4.0:1 (page-coloured knob, dark): state is carried by the
      // knob's colour as well as its position and icon.
      className={`group relative inline-flex items-center h-8 w-13 shrink-0 rounded-full border border-field bg-field transition-colors duration-200 after:absolute after:inset-x-0 after:-inset-y-2 after:content-[''] ${className}`}
    >
      {/* Position, colour and icon come from dark: variants, not from `theme`,
          so the prerendered HTML is already right for a dark-mode visitor
          before any JS has run. */}
      <span className="flex items-center justify-center h-6 w-6 rounded-full elevation-control transform transition-transform duration-200 translate-x-0.5 bg-white dark:translate-x-6 dark:bg-canvas">
        <Moon className="hidden dark:block w-4 h-4 text-slate-300" />
        <Sun className="dark:hidden w-4 h-4 text-slate-600" />
      </span>
    </button>
  );
}

// Page chrome. The header row, the card and the footer share ONE left edge on
// every screen: the gutter is the same as <main>'s (px-4, px-6 from sm), and the
// row is capped at the width of the card beneath it, so the logo sits on the
// card's left edge and the toggle / menu on its right. (It used to span the
// 1152px shell above a 900px or 672px card, ~100px outside it.) The width
// classes are written out in full so Tailwind sees them:
//   W_CONTENT  content pages: 672
//   W_HOME     home screen: 420 on phones, 672 on tablets (640-1023, same as the
//              content pages instead of a 420px island), 900 on desktop
const CHROME_GUTTER = "px-4 sm:px-6";
const CHROME_ROW = "flex items-center justify-between w-full mx-auto py-6";
const W_CONTENT = "max-w-content";
const W_HOME = "max-w-app-sm sm:max-w-content lg:max-w-app";

// Plain navigation links (footer, desktop header), each a 44px-tall target. Hover darkens AND underlines:
// the colour step alone (slate-500 to slate-600) was barely visible.
const NAV_LINK = "inline-flex items-center justify-center h-11 min-w-11 transition-colors hover:text-slate-900 dark:hover:text-white hover:underline underline-offset-4";

// --- Layout & Presentational Components --- //
// ONE set of site links. The header (inline from sm, in the menu below sm) shows
// NAV_LINKS on every page; the footer shows the same three plus the legal pages,
// in that order. Nothing else defines a link list.
const NAV_LINKS = [
  ["/how-it-works", "How it works"],
  ["/faq", "FAQ"],
  ["/contact", "Contact"],
] as const;
const FOOTER_LINKS = [
  ...NAV_LINKS,
  ["/privacy", "Privacy policy"],
  ["/terms", "Terms"],
] as const;

function Footer({ widthClass }: { widthClass: string }) {
  // Five links are ~390px wide, so on a phone they always wrap, and a plain
  // wrap leaves one link alone on the last row. On phones each link therefore
  // takes a third of the row (basis-1/3): three on the first row, two centred
  // on the second, and every link is at least a third of the row wide (44px+).
  // The dot separators are sm-and-up only; from sm the links sit on one row.
  const linkClass = `basis-1/3 whitespace-nowrap sm:basis-auto sm:px-1 ${NAV_LINK}`;
  return (
    <footer className={`mt-16 ${CHROME_GUTTER}`}>
     <div className={`mx-auto w-full ${widthClass} py-6 border-t border-edge-subtle text-center flex flex-col items-center`}>
      <nav aria-label="Footer" className="flex flex-wrap justify-center items-center sm:gap-x-4 mb-2 text-sm text-muted w-full">
        {FOOTER_LINKS.map(([to, label], i) => (
          <Fragment key={to}>
            {i > 0 && <span aria-hidden="true" className="hidden sm:inline">&middot;</span>}
            <Link to={to} className={linkClass}>{label}</Link>
          </Fragment>
        ))}
      </nav>
      {/* The year is the one thing that can differ between the prerendered HTML
          (built once) and the browser (today). suppressHydrationWarning stops
          that from discarding the server HTML on, say, January 1st. */}
      <p className="text-sm text-muted">© <span suppressHydrationWarning>{new Date().getFullYear()}</span> ZiptoGit. Created by Dipesh Nalawade.</p>
     </div>
    </footer>
  );
}

// The ONE brand mark: a 28px rounded tile in the brand colour (primary) with the
// GitHub glyph. It appears once per screen, in the page header (BrandLink); the
// home screen's sidebar and cards and the Contact page do not repeat it.
function BrandMark({ className = "" }: { className?: string }) {
  return (
    <div aria-hidden="true" className={`w-7 h-7 rounded-control bg-primary text-on-primary shrink-0 flex items-center justify-center transition-colors ${className}`}>
      <Github className="w-4 h-4" />
    </div>
  );
}

// The logo lockup, shared by every header so it cannot drift between pages.
// h-11 makes the link a 44px target and gives every header the same content
// height, whatever else sits beside it.
function BrandLink() {
  return (
    <Link to="/" className="flex items-center gap-3 h-11">
      <BrandMark />
      <span className={`${T.wordmark} text-ink dark:text-white`}>ZiptoGit</span>
    </Link>
  );
}

function PageLayout({ children }: { children: React.ReactNode }) {
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="min-h-dvh bg-canvas flex flex-col font-sans text-slate-900 dark:text-slate-100 transition-colors duration-200">
      <SiteHeader widthClass={W_CONTENT} theme={theme} onToggleTheme={toggleTheme} />
      {/* Content pages anchor to the top, whatever their length. They used to be
          vertically centred, so a short page (Contact) floated mid-screen while a
          long one started at the top. */}
      <main className="flex-1 flex flex-col items-center px-4 pt-4 pb-8 sm:px-6">
        {children}
      </main>
      <Footer widthClass={W_CONTENT} />
    </div>
  );
}

function RouteEffects() {
  const { pathname, key } = useLocation();
  const navigationType = useNavigationType();
  const previousPath = useRef(pathname);
  const scrollPositions = useRef(new Map<string, number>());

  useEffect(() => {
    const page = findPublicPage(pathname) ?? NOT_FOUND_PAGE;
    const url = SITE_ORIGIN + page.path;
    document.title = page.title;
    document.querySelector('link[rel="canonical"]')?.setAttribute("href", url);
    const tags = {
      'meta[name="description"]': page.description,
      'meta[name="robots"]': page.noindex ? "noindex, follow" : "index, follow",
      'meta[property="og:title"]': page.title,
      'meta[property="og:description"]': page.description,
      'meta[property="og:url"]': url,
      'meta[name="twitter:title"]': page.title,
      'meta[name="twitter:description"]': page.description,
    };
    for (const [selector, content] of Object.entries(tags)) {
      document.querySelector(selector)?.setAttribute("content", content);
    }
    const websiteSchema = document.getElementById(WEBSITE_SCHEMA_ID);
    if (page.path !== "/") {
      websiteSchema?.remove();
    } else if (!websiteSchema) {
      const script = document.createElement("script");
      script.id = WEBSITE_SCHEMA_ID;
      script.type = "application/ld+json";
      script.textContent = websiteStructuredData(SITE_ORIGIN);
      document.head.appendChild(script);
    }
    trackPageView();
  }, [pathname]);

  useLayoutEffect(() => {
    const previous = history.scrollRestoration;
    history.scrollRestoration = "manual";
    return () => { history.scrollRestoration = previous; };
  }, []);

  useLayoutEffect(() => {
    if (previousPath.current !== pathname) {
      previousPath.current = pathname;
      const heading = document.querySelector<HTMLElement>("main h1") ?? document.querySelector<HTMLElement>("main");
      if (heading) {
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      }
      window.scrollTo(0, navigationType === "POP" ? scrollPositions.current.get(key) ?? 0 : 0);
    }
    const saveScroll = () => scrollPositions.current.set(key, window.scrollY);
    saveScroll();
    window.addEventListener("scroll", saveScroll, { passive: true });
    return () => window.removeEventListener("scroll", saveScroll);
  }, [key, pathname, navigationType]);

  return null;
}

class UploaderErrorBoundary extends Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section className={`w-full max-w-content ${CARD_EDGE} p-6 sm:p-12`}>
        <h1 className={`${T.h1} mb-3`}>Couldn’t load the uploader</h1>
        <p role="alert" className="mb-4 text-muted">Reload the page to try again.</p>
        <button type="button" className={`${CTRL} bg-primary px-5 text-on-primary hover:bg-primary-hover`} onClick={() => window.location.reload()}>
          Reload page
        </button>
      </section>
    );
  }
}

// --- Home screen shell: full-width desktop layout with the app card
// centered in the middle of the page. --- //
function HomeLayout({ Uploader }: { Uploader: ComponentType }) {
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="min-h-dvh flex flex-col font-sans text-slate-900 dark:text-slate-100 bg-canvas relative transition-colors duration-200">
      {/* Dot-grid texture fills the desktop canvas outside the two columns. It is
          decorative (aria-hidden, never rendered below lg) but meant to be seen:
          about 2:1 against the canvas at its centre, fading out so it never
          reaches the card or the page edges. The dots and the fade are one
          static SVG background (.dot-grid in index.css), so the browser paints
          it once and there is no CSS mask or live gradient layer to keep. */}
      <div aria-hidden="true" className="dot-grid hidden lg:block absolute inset-0 pointer-events-none" />

      <SiteHeader widthClass={W_HOME} theme={theme} onToggleTheme={toggleTheme} />

      {/* Top-anchored, exactly like the content pages' <main> (same pt-4 pb-8 and
          gutters), so the card starts at the same height on every page instead
          of floating in the middle of the viewport. */}
      <main className="flex-1 flex flex-col items-center px-4 pt-4 pb-8 sm:px-6 relative">
        <UploaderErrorBoundary>
          <Uploader />
        </UploaderErrorBoundary>
      </main>

      <Footer widthClass={W_HOME} />
    </div>
  );
}

// The ONE page header, used by the home screen and every content page: logo on
// the left, NAV_LINKS + theme toggle on the right (inline from sm; below sm the
// links move into a menu behind a button, the toggle stays visible).
function SiteHeader({ widthClass, theme, onToggleTheme }: { widthClass: string; theme: Theme; onToggleTheme: () => void }) {
  const [open, setOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      menuButton.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  const linkClass = "flex items-center h-11 rounded-control px-3 text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-tint-2";
  return (
    <header className={`relative ${CHROME_GUTTER}`}>
      <div className={`relative ${CHROME_ROW} ${widthClass}`}>
        <BrandLink />
        <nav aria-label="Site" className="hidden sm:flex items-center gap-6 text-sm text-muted">
          {NAV_LINKS.map(([to, label]) => (
            <Link key={to} to={to} className={NAV_LINK}>{label}</Link>
          ))}
          <div className="w-px h-4 bg-edge-subtle" />
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        </nav>
        <div className="flex sm:hidden items-center gap-2">
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
          <button
            type="button"
            ref={menuButton}
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls="mobile-menu"
            aria-label={open ? "Close menu" : "Open menu"}
            className="h-11 w-11 inline-flex items-center justify-center rounded-control text-slate-700 dark:text-slate-200 hover:bg-tint-3"
          >
            {open ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
        {open && (
          <nav
            id="mobile-menu"
            aria-label="Site menu"
            className="sm:hidden absolute right-0 top-full -mt-2 z-20 w-56 rounded-panel border border-edge bg-surface elevation-raised p-2"
          >
            {NAV_LINKS.map(([to, label]) => (
              <Link key={to} to={to} onClick={() => setOpen(false)} className={linkClass}>{label}</Link>
            ))}
          </nav>
        )}
      </div>
    </header>
  );
}

// --- Content Pages --- //
// Bump this whenever the Privacy policy copy below actually changes — it must
// never be computed at render time (was `new Date().toLocaleDateString()`,
// which falsely told every visitor the policy was updated that same day).
const PRIVACY_LAST_UPDATED = "November 19, 2026";
// Change this date whenever the Terms copy changes.
const TERMS_LAST_UPDATED = "August 10, 2026";

function PrivacyPage() {
  return (
    <PageLayout>
      <div className={`w-full max-w-content ${CARD_EDGE} p-6 sm:p-12 ${T.prose}`}>
        <h1 className={`${T.h1} text-ink dark:text-white mb-6`}>Privacy policy</h1>
        <p className="mb-4 text-sm text-muted">Last updated: {PRIVACY_LAST_UPDATED}</p>
        <h2 className={`${T.h2} mt-6 mb-3`}>1. Information we collect</h2>
        <p className="mb-4">ZiptoGit requests GitHub OAuth repository access to read and push files to repositories you can access, including private repositories. If you choose to authorize repository deletion, ZiptoGit requests the <code>delete_repo</code> permission from GitHub. This feature asks you to confirm before deleting a repository. We do not store your repository contents or your source code on our servers.</p>
        <h2 className={`${T.h2} mt-6 mb-3`}>2. How we use information</h2>
        <p className="mb-4">Your browser stores your GitHub access token in a signed HttpOnly session cookie. HttpOnly prevents page scripts from reading it. The server uses the cookie to make GitHub API requests on your behalf. The cookie expires after 30 days. If you disconnect, ZiptoGit revokes the session token on GitHub and clears the cookie.</p>
        <h2 className={`${T.h2} mt-6 mb-3`}>3. Third-party services</h2>
        <p className="mb-4">We use Google Analytics to monitor usage and improve the tool. We do not sell your data.</p>
      </div>
    </PageLayout>
  );
}

function TermsPage() {
  return (
    <PageLayout>
      <div className={`w-full max-w-content ${CARD_EDGE} p-6 sm:p-12 ${T.prose}`}>
        <h1 className={`${T.h1} text-ink dark:text-white mb-6`}>Terms of service</h1>
        <p className="mb-4 text-sm text-muted">Last updated: {TERMS_LAST_UPDATED}</p>
        <p className="mb-4">Welcome to ZiptoGit by Dipesh Nalawade!</p>
        <h2 className={`${T.h2} mt-6 mb-3`}>1. Acceptance of terms</h2>
        <p className="mb-4">By accessing or using our service, you agree to these Terms. If you do not agree, do not use the service.</p>
        <h2 className={`${T.h2} mt-6 mb-3`}>2. Responsible use</h2>
        <p className="mb-4">You are responsible for what you upload to your connected GitHub repositories. We are not liable for any code overrides, data loss, or unintended repository modifications.</p>
        <h2 className={`${T.h2} mt-6 mb-3`}>3. Disclaimer of warranties</h2>
        <p className="mb-4">ZiptoGit is provided “as is” without warranty of any kind. Use at your own risk.</p>
      </div>
    </PageLayout>
  );
}

function ContactPage() {
  return (
    <PageLayout>
      <div className={`w-full max-w-content ${CARD_EDGE} p-6 sm:p-12 ${T.prose}`}>
        <h1 className={`${T.h1} text-ink dark:text-white mb-6`}>Contact</h1>
        <p className="mb-8">Have a question, feedback, or need support? Reach out directly.</p>

        <div className="inline-flex flex-col items-start gap-2 p-6 bg-tint-1 rounded-panel border border-edge">
          <span className={`${T.eyebrow} text-muted`}>Support email</span>
          <a href="mailto:support@ziptogit.in" className="inline-flex items-center min-h-11 text-lg font-medium text-ink dark:text-white hover:underline">support@ziptogit.in</a>
        </div>
      </div>
    </PageLayout>
  );
}

const uploadLimitMiB = MAX_TOTAL_UPLOAD_BYTES / (1024 * 1024);

const HOW_IT_WORKS_STEPS = [
  {
    title: "Connect GitHub",
    body: "Sign in with your GitHub account. Your browser keeps the access token in an HttpOnly cookie for the server to use when making GitHub API requests.",
  },
  {
    title: "Add a ZIP or folder",
    body: `Choose a ZIP archive, including an AI Studio export, or select a project folder on desktop. ZiptoGit extracts ZIPs in your browser. The total file size limit is ${uploadLimitMiB} MiB after extraction. ${SECRET_SCAN_NOTE}`,
  },
  {
    title: "Commit files to GitHub",
    body: "Choose a repository and review your files before pushing. ZiptoGit creates one commit for the upload. If the repository has never had a commit, ZiptoGit initializes it with a separate commit first.",
  },
];

function HowItWorksPage() {
  return (
    <PageLayout>
      <div className={`w-full max-w-content ${CARD_EDGE} p-6 sm:p-12 ${T.prose}`}>
        <h1 className={`${T.h1} text-ink dark:text-white mb-6`}>How to upload a ZIP to GitHub</h1>
        <ol className="space-y-6">
          {HOW_IT_WORKS_STEPS.map((step, i) => (
            <li key={step.title} className="flex gap-4">
              {/* mt-0.5 centres the 24px badge on the title's 28px line. */}
              <StepBadge n={i + 1} status="static" className="mt-0.5" />
              <div>
                <h2 className={`${T.h2} mb-2`}>{step.title}</h2>
                <p>{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </PageLayout>
  );
}

function FAQPage() {
  const faqs = [
    { q: "How are my files and GitHub token handled?", a: `ZiptoGit extracts your ZIP in your browser. ${SECRET_SCAN_NOTE} The server sends your files to GitHub using the access token from your browser’s HttpOnly session cookie.` },
    { q: "What can I upload?", a: `You can upload a ZIP archive or select a project folder on desktop. The total limit for files is ${uploadLimitMiB} MiB after ZIP extraction.` },
    { q: "Which GitHub permissions does ZiptoGit request?", a: "ZiptoGit requests the repo permission to read and push files in repositories you can access, including private repositories. If you authorize repository deletion, ZiptoGit asks GitHub for the separate delete_repo permission. You must still confirm the repository name before deleting it." },
    { q: "What does ZiptoGit cost?", a: "It is currently completely free to use." },
    { q: "Can I use it for private repositories?", a: "Yes. You can upload files to a private repository if your GitHub account has permission to commit to it." }
  ];

  return (
    <PageLayout>
      <div className={`w-full max-w-content ${CARD_EDGE} p-6 sm:p-12 ${T.prose}`}>
        <h1 className={`${T.h1} text-ink dark:text-white mb-6`}>Frequently asked questions</h1>
        <div className="space-y-4">
          {faqs.map((faq, i) => (
            <div key={i} className="p-6 border border-edge rounded-panel bg-tint-1">
              <h2 className={`${T.h2} mb-2`}>{faq.q}</h2>
              <p>{faq.a}</p>
            </div>
          ))}
        </div>
      </div>
    </PageLayout>
  );
}

function NotFoundPage() {
  return (
    <PageLayout>
      <div className={`w-full max-w-content ${CARD_EDGE} p-6 sm:p-12 ${T.prose}`}>
        <h1 className={`${T.h1} text-ink dark:text-white mb-3`}>Page not found</h1>
        <p className="mb-6">The address may have changed, or the link may be incorrect.</p>
        <Link to="/" className="text-primary font-medium underline">Go to homepage</Link>
      </div>
    </PageLayout>
  );
}

// --- Main App / Router --- //
// The routes on their own, so the prerender step (src/entry-server.tsx) can
// render them inside a StaticRouter while the browser uses BrowserRouter.
export function AppRoutes({ Uploader }: { Uploader: ComponentType }) {
  return (
    <Routes>
      <Route path="/" element={<HomeLayout Uploader={Uploader} />} />
      <Route path="/how-it-works" element={<HowItWorksPage />} />
      <Route path="/privacy" element={<PrivacyPage />} />
      <Route path="/terms" element={<TermsPage />} />
      <Route path="/faq" element={<FAQPage />} />
      <Route path="/contact" element={<ContactPage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

export default function App({ Uploader }: { Uploader: ComponentType }) {
  return (
    <BrowserRouter>
      <Suspense fallback={null}>
        <RouteEffects />
        <AppRoutes Uploader={Uploader} />
      </Suspense>
    </BrowserRouter>
  );
}
