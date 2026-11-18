import { useState, useEffect, useLayoutEffect, useRef, useCallback, Fragment, useId, useSyncExternalStore, lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, Link } from "react-router-dom";
import { fetchRepositories, fetchBootstrap, warmZipExtractor, extractZip, extractFolder, filesFromDataTransferItems, uploadToGitHub, ExtractedFile, fetchRepoTree, deleteRepoPaths, deleteRepository, createRepository, logout as apiLogout, RepoTreeEntry } from "./lib/github";
import { trackEvent, trackPageView } from "./lib/analytics";
import { mergeRepos } from "./lib/repos";
import { avatarSrc, AVATAR_PX } from "./lib/avatar";
import { prefetchAuthUrl, takeAuthUrl } from "./lib/authUrl";
import { readSessionFlag, clearSessionFlag, sessionPending, endSessionPending } from "./lib/session";
import { PAGE_TITLES, HOME_TITLE } from "./routes";
import { Github, LogOut, Upload, Loader2, CheckCircle, AlertCircle, FileArchive, X, Check, ChevronDown, Folder, FolderOpen, Trash2, ShieldCheck, Plus, Lock, Globe, Sun, Moon, ExternalLink, Menu } from "lucide-react";

// Code that is only needed after the visitor does something is loaded on
// demand, so it is not part of the first download:
//  - jszip (see extractZip in lib/github.ts): after a ZIP is picked
//  - the secret scanner: when "Push" is pressed
//  - the repository file tree: in the Manage files view
// Each loader is also called early (idle time once signed in, or in parallel
// with the tree request) so the chunk is usually already cached when needed.
const loadSecretScanner = () => import("./lib/secretScanner");
const loadRepoFileTree = () => import("./components/RepoFileTree");
const RepoFileTree = lazy(loadRepoFileTree);

// Sentinel value for the "Create new repository" option in the repo <select>.
// Never a real full_name, so it can't collide with an actual repo.
const CREATE_NEW_REPO_VALUE = "__create_new_repo__";

// Suggests the next free "ziptogit.in_newN" name given the user's existing
// repos, so the default we show never collides with one they already have.
function suggestRepoName(existingRepos: any[]): string {
  const takenNames = new Set(existingRepos.map((r) => String(r.name).toLowerCase()));
  let i = 1;
  while (takenNames.has(`ziptogit.in_new${i}`.toLowerCase())) i++;
  return `ziptogit.in_new${i}`;
}

// GitHub repo names allow letters, numbers, '.', '-', '_' only.
const REPO_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

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

// --- Typography roles --- //
// The roles that repeat across screens live here so they can't drift apart.
// Tailwind still sees every class because they are literal strings. The scale
// and the rules behind these (sizes, weights, leading) are documented in
// src/index.css; the short version:
//   Size     4 steps: sm 14 (app UI, the floor), base 16, lg 18, 2xl 24.
//            ONE page-title size: every h1 is 2xl, in the app and on content pages.
//   Weight   semibold = headings ONLY (h1, h2, step titles, block titles)
//            medium   = controls, the active nav item, labels, names, the wordmark,
//                       the drop-zone title, step numbers
//            normal   = body, helper text, alerts, eyebrows   (bold is not used)
//   Mono     only where characters must be read exactly: repo-name inputs, the
//            file tree, "type X to confirm" and the demo terminal. Never in
//            headings, the breadcrumb or running prose.
//   Leading  always a multiple of 4px: the size token's own line-height, except
//            16px prose (leading-7, 28px) and multi-line 14px paragraphs with no
//            leading icon (leading-6, 24px). Never leading-relaxed.
const T = {
  wordmark: "text-base font-medium tracking-tight",
  // No colour on h1: every h1 adds text-ink dark:text-white where it is used.
  h1: "text-2xl font-semibold tracking-tight",
  // Content-page headings: section headings and item titles (How it works steps,
  // FAQ questions). Add margin where it is used.
  h2: "text-lg font-semibold text-slate-900 dark:text-white",
  prose: "text-base leading-7 text-slate-700 dark:text-slate-300",
  // The quietest label in the app: normal weight, uppercase and tracked, in a
  // muted colour. It names a group, so it must never outrank the items in it.
  eyebrow: "text-sm font-normal uppercase tracking-wide",
  // Headings inside the app card: step titles, "Files in …", "Danger zone".
  // Add the colour where it is used (the danger zone is red).
  title: "text-base font-semibold",
  // A prompt that is not a heading (the drop zone's "Drop a ZIP or folder here").
  prompt: "text-base font-medium text-slate-900 dark:text-slate-100",
};

// Casing: sentence case everywhere ("Select repository", "How it works").
// Capitals only for proper nouns and acronyms (GitHub, ZIP, FAQ).

// Card: ONE recipe for every top-level card: the home card (desktop and phone)
// and all content pages. The card is only 1.09:1 against the page, so it gets
// a border plus the `card` elevation (tokens in index.css) to separate it.
const CARD_EDGE = "bg-surface rounded-card border border-edge elevation-card";

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

// Controls: every button, input and select is 44px tall (see the spacing rules
// in index.css). BTN is the shared shape; colour comes from BTN_PRIMARY /
// BTN_SECONDARY / BTN_DANGER below. Text size is set where it is used (text-sm
// everywhere except the two page-level CTAs, which are text-base).
const CTRL = "h-11 rounded-control";
const BTN = `${CTRL} px-4 font-medium inline-flex items-center justify-center gap-2`;
const FIELD = `${CTRL} w-full px-4 text-sm bg-input text-slate-900 dark:text-slate-100`;

// Plain navigation links (footer, desktop header), each a 44px-tall target. Hover darkens AND underlines:
// the colour step alone (slate-500 to slate-600) was barely visible.
const NAV_LINK = "inline-flex items-center justify-center h-11 min-w-11 transition-colors hover:text-slate-900 dark:hover:text-white hover:underline underline-offset-4";

// The two dashboard views. The desktop sidebar, the phone's segmented switch AND
// each view's h1 render from this list, so a destination has exactly one name.
// (Push view: "Push files" in the nav, the h1 and the main button. Manage view:
// "Manage files" in the nav and the h1. There is no breadcrumb: it only repeated
// the nav and its first crumb pointed at a dashboard that does not exist.)
const VIEWS = [
  { id: "push", label: "Push files", icon: Upload },
  { id: "manage", label: "Manage files", icon: FolderOpen },
] as const;

// Filled primary button. Disabled is a distinct flat style (6.1-6.2:1 text in both
// themes, via the disabled / on-disabled tokens in index.css), not
// "the same button at 50% opacity", and it never gets a hover.
const BTN_PRIMARY =
  "bg-primary text-on-primary transition-colors enabled:hover:bg-primary-hover disabled:cursor-not-allowed disabled:bg-disabled disabled:text-on-disabled";


// The page's main action ("Push files"). Same as BTN_PRIMARY, but while it is
// waiting for the repository and files it stays brand-tinted (cta-disabled /
// on-cta-disabled tokens, 6.3:1 light, 6.5:1 dark) instead of going flat grey, so
// it still reads as the action the page is building towards.
const BTN_CTA =
  "bg-primary text-on-primary transition-colors enabled:hover:bg-primary-hover disabled:cursor-not-allowed disabled:bg-cta-disabled disabled:text-on-cta-disabled";

// Secondary (outlined) and destructive buttons. Destructive comes in two weights:
// BTN_DANGER (solid red) is for the irreversible actions ("Delete repository…",
// "Delete forever"); BTN_DANGER_OUTLINE (red outline) is for the reversible
// "Delete selected" (it is a commit; the files stay in the repository's history).
const BTN_SECONDARY =
  "bg-input text-slate-700 dark:text-slate-200 border border-field transition-colors hover:bg-tint-2";
const BTN_DANGER =
  "bg-red-700 text-white transition-colors enabled:hover:bg-red-800 disabled:cursor-not-allowed disabled:bg-disabled disabled:text-on-disabled";
// Colours are all behind `enabled:` so the flat disabled style (the base classes)
// cannot be overridden by a dark: variant.
const BTN_DANGER_OUTLINE =
  "border border-transparent bg-disabled text-on-disabled transition-colors disabled:cursor-not-allowed enabled:bg-transparent enabled:border-red-500 dark:enabled:border-red-400/60 enabled:text-red-700 dark:enabled:text-red-300 enabled:hover:bg-red-50 dark:enabled:hover:bg-red-500/10";

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

// The ONE inline message: same padding, text size, border strength, icon and
// icon size for every error, success and warning (previously p-3 text-sm,
// p-2.5 text-xs and bare red text, with red-100 and red-200 borders mixed).
// Errors use role="alert" so they are announced; the rest use role="status".
const ALERT_VARIANTS = {
  error: {
    icon: AlertCircle,
    role: "alert",
    box: "bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30 text-red-700 dark:text-red-300",
  },
  success: {
    icon: CheckCircle,
    role: "status",
    box: "bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/30 text-emerald-800 dark:text-emerald-300",
  },
  warning: {
    icon: ShieldCheck,
    role: "status",
    box: "bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/30 text-amber-900 dark:text-amber-300",
  },
} as const;

function Alert({ variant, className = "", children }: { variant: keyof typeof ALERT_VARIANTS; className?: string; children: React.ReactNode }) {
  const { icon: Icon, role, box } = ALERT_VARIANTS[variant];
  return (
    <div role={role} className={`p-3 rounded-control border text-sm flex items-start gap-2 ${box} ${className}`}>
      <Icon aria-hidden="true" className="w-4 h-4 shrink-0 mt-0.5" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

// The ONE Cancel button. Always the secondary style, always first in its row,
// always half the row (flex-1) next to the action it cancels.
function CancelButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${BTN} ${BTN_SECONDARY} flex-1 text-sm disabled:opacity-50 disabled:cursor-not-allowed`}
    >
      Cancel
    </button>
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

function PageLayout({ children, title }: { children: React.ReactNode, title?: string }) {
  usePageTracking(title, title ? `${title} | ZiptoGit` : undefined);
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

// Tracks page views (GA) and sets the document title. Shared by PageLayout
// (content pages) and HomeLayout (the main app screen), which has its own
// wider desktop shell but needs the same tracking behavior. `title` is the
// short screen name sent to analytics; `documentTitle` is the full tab title,
// and must equal what the prerendered HTML already has for that page, so a
// crawler without JS and a browser after mount see the same <title>.
function usePageTracking(title: string | undefined, documentTitle: string | undefined) {
  useEffect(() => {
    trackPageView(title);
    if (documentTitle) document.title = documentTitle;
  }, [title, documentTitle]);
}

// --- Home screen shell: full-width desktop layout with the app card
// centered in the middle of the page. --- //
function HomeLayout() {
  usePageTracking("Home", HOME_TITLE);
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
        <ZipUploader />
      </main>

      <Footer widthClass={W_HOME} />
    </div>
  );
}

// --- Small shared pieces for the home screen --- //
function useMediaQuery(query: string) {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query]
  );
  // The server snapshot (false) is what the prerendered HTML was built with and
  // what hydration renders first; React then re-renders with the real value if
  // it differs. A plain useState(matchMedia(...)) would render the desktop
  // markup on the first client render and fail to match.
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false
  );
}

// True while the tab is visible. Used to stop decorative timers in a background
// tab. The server snapshot is true so the prerendered markup is the "running"
// one (nothing is paused before the page is interactive).
function usePageVisible() {
  return useSyncExternalStore(
    (onChange) => {
      document.addEventListener("visibilitychange", onChange);
      return () => document.removeEventListener("visibilitychange", onChange);
    },
    () => document.visibilityState === "visible",
    () => true
  );
}

// True while any part of the element is on screen. It starts true (what the
// prerendered HTML assumes, so nothing is held back before hydration) and the
// observer corrects it right after mount. Without IntersectionObserver the
// element simply counts as on screen.
function useInView(ref: { current: Element | null }) {
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      setInView(entries[entries.length - 1].isIntersecting);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return inView;
}

type StepStatus = "done" | "current" | "upcoming";

// The ONE numbered-step badge (24px, 14/500), used by the home screen's
// Repository / Files steps and by the "How it works" list. Outlined, never
// filled, so it stays quieter than any button: a done step shows a green check,
// the current step has an ink ring, upcoming steps are muted. A list that is
// only read (How it works) uses "static", which looks like "current".
function StepBadge({ n, status, className = "" }: { n: number; status: StepStatus | "static"; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`w-6 h-6 shrink-0 rounded-full flex items-center justify-center text-sm font-medium ${
        status === "done"
          ? "border border-emerald-700 text-emerald-700 dark:border-emerald-400 dark:text-emerald-400"
          : status === "upcoming"
            ? "border border-edge text-muted"
            : "border border-ink text-ink dark:border-white dark:text-white"
      } ${className}`}
    >
      {status === "done" ? <Check className="w-4 h-4" strokeWidth={2.5} /> : n}
    </span>
  );
}

// Heading for the Repository -> Files steps that lead to the Push button.
function StepHeader({ n, title, status, titleId }: { n: number; title: string; status: StepStatus; titleId?: string }) {
  return (
    <div className="flex items-center gap-3 mb-3">
      <StepBadge n={n} status={status} />
      <h2
        className={`${T.title} ${
          status === "upcoming" ? "text-muted" : "text-slate-900 dark:text-slate-100"
        }`}
      >
        <span className="sr-only">Step {n}{status === "done" ? " (complete)" : ""}: </span>
        <span id={titleId}>{title}</span>
      </h2>
    </div>
  );
}

// One sidebar entry. This is navigation between two views, so it has a real
// active state (aria-current) shown with exactly two cues: a tinted fill and ink
// text/icon against the muted inactive rows. No ring, bar or extra weight.
function SidebarItem({
  active,
  icon: Icon,
  onClick,
  children,
}: {
  active: boolean;
  icon: React.ComponentType<{ className?: string }>;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-3 h-11 text-sm font-medium rounded-control px-3 text-left transition-colors ${
        active
          ? "bg-tint-3 text-ink dark:text-white"
          : "text-muted hover:bg-tint-2 hover:text-ink dark:hover:text-white"
      }`}
    >
      <Icon className="w-4 h-4" />
      {children}
    </button>
  );
}

// The ONE page header, used by the home screen and every content page: logo on
// the left, NAV_LINKS + theme toggle on the right (inline from sm; below sm the
// links move into a menu behind a button, the toggle stays visible).
function SiteHeader({ widthClass, theme, onToggleTheme }: { widthClass: string; theme: Theme; onToggleTheme: () => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
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
              <Link key={to} to={to} className={linkClass}>{label}</Link>
            ))}
          </nav>
        )}
      </div>
    </header>
  );
}

// Looping demo of what the app does (extract -> scan -> commit -> push) for the
// signed-out desktop screen. It sits inside the card, so it has a border and no
// shadow of its own (elevation-raised is for things that float: the menu). Purely decorative (aria-hidden): the heading and
// copy next to it say the same thing in words. The ztg-* keyframes it uses live
// in index.css. With reduced motion it holds still on the finished state. It
// also holds still (timer cleared, CSS animations paused) while it is scrolled
// out of view or the tab is in the background.
const TERMINAL_STAGES = ["Extract", "Scan", "Commit", "Push"];
const TERMINAL_FILES = ["package.json", "src/App.tsx", "src/index.css", "README.md"];
const TERMINAL_LINES: { at: number; text: string; ok: boolean }[] = [
  { at: 0, text: "Extracting my-project.zip…", ok: false },
  { at: 1, text: "24 files extracted", ok: true },
  { at: 1, text: "Scanning for secrets…", ok: false },
  { at: 2, text: ".env excluded · no secrets left", ok: true },
  { at: 2, text: "Committing 23 files…", ok: false },
  { at: 3, text: "Pushed to you/my-project", ok: true },
];

function ZipToGitTerminal() {
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  // The signed-out card is one responsive layout and this panel is only shown
  // from lg up (CSS), so below that it exists in the DOM but must not keep a
  // timer running.
  const isShown = useMediaQuery("(min-width: 1024px)");
  const rootRef = useRef<HTMLDivElement>(null);
  const inView = useInView(rootRef);
  const pageVisible = usePageVisible();
  const running = !reduceMotion && isShown && inView && pageVisible;
  // tick counts up forever; each loop is 5 ticks: stages 0-3, then one beat
  // holding the finished state before the next loop starts.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1800);
    return () => window.clearInterval(id);
  }, [running]);
  const phase = tick % 5;
  const loop = Math.floor(tick / 5);
  const stage = reduceMotion ? 3 : Math.min(phase, 3);
  const finished = reduceMotion || phase === 4;

  return (
    <div
      ref={rootRef}
      aria-hidden="true"
      // ztg-paused (index.css) freezes the cursor blink and the pulse ring while
      // off screen. Not applied for reduced motion: there every animation is
      // already collapsed to its end state, and freezing would pin it at the start.
      className={`w-full rounded-panel bg-ink dark:bg-slate-950 border border-edge overflow-hidden font-mono text-sm text-slate-300 select-none${
        !reduceMotion && !(inView && pageVisible) ? " ztg-paused" : ""
      }`}
    >
      <div className="px-4 py-3 border-b border-white/10 text-slate-400 truncate">my-project.zip → you/my-project</div>
      {/* The panel is always its finished height. Every line is in the layout from
          the first paint; a line that has not been "printed" yet is only
          visibility:hidden (it keeps its space), and printing it plays an
          opacity + transform animation. Nothing is added or removed, so the
          card, the vertically centred panel and the stage bar never move
          (no layout shift), and the loop restart does not collapse the panel.
          The hidden copy holds the same text, so a line that wraps at a narrow
          width reserves the same height as the visible one. */}
      <div className="p-4 space-y-2">
        <p><span className="text-emerald-400">$</span> ziptogit push my-project.zip</p>
        <div className="flex flex-wrap gap-2 py-1">
          {TERMINAL_FILES.map((f, i) => (
            <span
              key={`${loop}-${f}`}
              style={{ animation: `ztg-chip-in 420ms ease-out ${i * 140}ms both` }}
              className="px-2 py-1 rounded-control bg-white/10 text-slate-200"
            >
              {f}
            </span>
          ))}
        </div>
        {TERMINAL_LINES.map((l, i) => {
          const shown = stage >= l.at;
          return (
            <p
              // A new key when a line appears (and again on each loop) remounts
              // it, which restarts its entrance animation.
              key={shown ? `${loop}-${i}` : `idle-${i}`}
              style={shown ? { animation: "ztg-line-in 300ms ease-out both" } : undefined}
              className={`${l.ok ? "text-emerald-400" : "text-slate-300"}${shown ? "" : " invisible"}`}
            >
              {l.ok ? "✓" : "›"} {l.text}
            </p>
          );
        })}
        <div key={stage >= 2 ? `${loop}-node` : "idle-node"} className={`flex items-center gap-3 pt-1${stage >= 2 ? "" : " invisible"}`}>
          <span
            style={stage >= 2 ? { animation: "ztg-node-pop 450ms ease-out both" } : undefined}
            className="w-3 h-3 rounded-full bg-emerald-400 shrink-0"
          />
          <span className="text-slate-200 truncate">Upload files via ZiptoGit</span>
          <span className={`text-slate-400${stage >= 3 ? "" : " invisible"}`}>a1b2c3d</span>
        </div>
        <span style={{ animation: "ztg-blink 1s steps(1) infinite" }} className="inline-block w-2 h-4 bg-slate-300 align-middle" />
      </div>
      <div className="flex items-center justify-between px-4 py-3 border-t border-white/10">
        {TERMINAL_STAGES.map((label, i) => {
          const done = i < stage || (finished && i === 3);
          const active = i === stage && !done;
          return (
            <span key={label} className={`flex items-center gap-2 ${done ? "text-emerald-400" : active ? "text-white" : "text-slate-400"}`}>
              <span className={`relative w-2.5 h-2.5 rounded-full ${done ? "bg-emerald-400" : active ? "bg-white" : "bg-slate-600"}`}>
                {active && <span style={{ animation: "ztg-pulse-ring 1.2s ease-out infinite" }} className="absolute inset-0 rounded-full border border-emerald-500" />}
              </span>
              {label}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function ZipUploader() {
  const [user, setUser] = useState<any>(null);
  // False on the first render on purpose: that is what the prerendered HTML
  // (the signed-out hero) contains, and hydration has to match it. The effect
  // below turns it on for a returning visitor before anything is painted.
  const [isCheckingAuth, setIsCheckingAuth] = useState(false);
  const [repos, setRepos] = useState<any[]>([]);
  // The repository list arrives page by page: the first page with the user (so
  // the dashboard can appear), the rest in the background. repoLoadGen is bumped
  // whenever that background load must stop being applied (sign-out, a new load).
  const [isLoadingMoreRepos, setIsLoadingMoreRepos] = useState(false);
  const [repoListError, setRepoListError] = useState<string | null>(null);
  const repoLoadGen = useRef(0);
  const [selectedRepoFullId, setSelectedRepoFullId] = useState<string>("");
  // The default branch comes with the repository list, and passing it to the
  // file-tree request saves the server two GitHub round trips. A ref, so the
  // tree effect reads the current list without re-running every time another
  // page of repositories arrives.
  const reposRef = useRef(repos);
  reposRef.current = repos;
  const defaultBranchOf = (fullName: string): string | undefined =>
    reposRef.current.find((r: any) => r.full_name === fullName)?.default_branch || undefined;

  // --- Create a new repository directly from the dropdown --- //
  const [isCreatingRepo, setIsCreatingRepo] = useState(false);
  const [newRepoName, setNewRepoName] = useState("");
  const [newRepoIsPrivate, setNewRepoIsPrivate] = useState(false); // defaults to public
  const [isSubmittingNewRepo, setIsSubmittingNewRepo] = useState(false);
  const [createRepoErrorMsg, setCreateRepoErrorMsg] = useState<string | null>(null);
  
  // Tracks whichever source is currently loaded — a ZIP file or a picked/dropped
  // folder — since both feed the same extractedFiles pipeline below.
  const [selectedSource, setSelectedSource] = useState<{ kind: "zip" | "folder"; name: string } | null>(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [extractedFiles, setExtractedFiles] = useState<ExtractedFile[]>([]);
  const [isExtracting, setIsExtracting] = useState(false);
  const [isReadingFolder, setIsReadingFolder] = useState(false);
  const [extractingName, setExtractingName] = useState("");
  
  const [isUploading, setIsUploading] = useState(false);
  const [uploadStatusMsg, setUploadStatusMsg] = useState("");
  const [uploadProgress, setUploadProgress] = useState({ current: 0, total: 0 });
  const [uploadSuccessUrl, setUploadSuccessUrl] = useState<string | null>(null);
  // What the success panel shows after a push (counts + commit), and any push-specific error.
  const [pushResult, setPushResult] = useState<{
    repo: string; fileCount: number; skipped: number; redacted: number; commitSha?: string; commitUrl?: string;
  } | null>(null);
  const [pushErrorMsg, setPushErrorMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [secretWarningMsg, setSecretWarningMsg] = useState<string | null>(null);

  // --- File/folder deletion (manage existing repo contents) --- //
  // Which view the dashboard shows. "manage" is the file manager + danger zone;
  // it used to be an inline toggle, now it is a proper view in the sidebar.
  const [view, setView] = useState<"push" | "manage">("push");
  const [treeReloadKey, setTreeReloadKey] = useState(0);
  const [repoTree, setRepoTree] = useState<RepoTreeEntry[]>([]);
  // GitHub cuts the file list off for very large repositories; then the tree
  // shown is only part of the repository.
  const [treeTruncated, setTreeTruncated] = useState(false);
  const [isLoadingTree, setIsLoadingTree] = useState(false);
  const [treeErrorMsg, setTreeErrorMsg] = useState<string | null>(null);
  const [selectedDeletePaths, setSelectedDeletePaths] = useState<Set<string>>(new Set());
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteStatusMsg, setDeleteStatusMsg] = useState("");
  const [deleteSuccessMsg, setDeleteSuccessMsg] = useState<string | null>(null);

  // --- Delete entire repository (danger zone) --- //
  const [showDeleteRepoConfirm, setShowDeleteRepoConfirm] = useState(false);
  const [deleteRepoConfirmText, setDeleteRepoConfirmText] = useState("");
  const [isDeletingRepo, setIsDeletingRepo] = useState(false);
  const [deleteRepoErrorMsg, setDeleteRepoErrorMsg] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const repoSelectRef = useRef<HTMLSelectElement>(null);

  // Ids that tie visible labels to their controls and regions.
  const repoSelectId = useId();
  const repoLabelId = useId();
  const filesLabelId = useId();
  const newRepoNameId = useId();
  const deleteConfirmHintId = useId();

  // Start-up auth check. The session cookie is HttpOnly, so JS cannot see it,
  // but the server also sets a readable has_session flag beside it. No flag
  // means no session: the hero shows at once and no request is made. With the
  // flag, index.html has already started GET /api/bootstrap (fetchBootstrap() picks that
  // up) and hidden the prerendered hero, and we show the spinner until it
  // answers. Layout effect, so the swap happens before the next paint.
  // sessionPending() is index.html's verdict from page load; the cookie alone
  // is not enough, because that early request can come back 401 and clear the
  // flag before this bundle has even booted. The cookie still matters for
  // arriving here by client-side navigation, where index.html's script did not run.
  useLayoutEffect(() => {
    if (!sessionPending() && !readSessionFlag()) return;
    setIsCheckingAuth(true);
    endSessionPending();
    loadUserData().finally(() => setIsCheckingAuth(false));
  }, []);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === "OAUTH_AUTH_SUCCESS") {
        // State validation now happens server-side in /auth/callback (bound
        // to a signed, HttpOnly cookie set by /api/auth/url) before the
        // session cookie is ever set, so a forged callback never gets here
        // with OAUTH_AUTH_SUCCESS in the first place.
        loadUserData();
      }
    };
    
    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
      repoLoadGen.current++;
    };
  }, []);

  // Pages 2.. of the repository list, one after another, appended as they
  // arrive. Runs after the UI is already showing.
  const loadMoreRepos = async (startPage: number, gen: number) => {
    setIsLoadingMoreRepos(true);
    try {
      let page: number | null = startPage;
      while (page && gen === repoLoadGen.current) {
        const result = await fetchRepositories(page);
        if (gen !== repoLoadGen.current) return;
        setRepos((prev) => mergeRepos(prev, result.repos));
        page = result.nextPage;
      }
    } catch (err) {
      if (gen !== repoLoadGen.current) return;
      console.error(err);
      setRepoListError("Some of your repositories could not be loaded. Reload the page to try again.");
    } finally {
      if (gen === repoLoadGen.current) setIsLoadingMoreRepos(false);
    }
  };

  const loadUserData = async () => {
    const gen = ++repoLoadGen.current;
    try {
      // One request: the user and the first page of repositories, which the
      // server fetches from GitHub in parallel.
      const { user: pUser, repos: firstPage, nextPage } = await fetchBootstrap();
      setUser(pUser);
      setRepos(firstPage);
      setRepoListError(null);
      if (firstPage.length > 0 && !selectedRepoFullId) {
        setSelectedRepoFullId(firstPage[0].full_name);
      }
      if (nextPage) void loadMoreRepos(nextPage, gen);
    } catch (err: any) {
      if (err.status === 401) {
        // Not signed in yet — this is the expected state before connecting GitHub.
        // (Or a stale flag: the server clears it on a 401, this covers the rest.)
        clearSessionFlag();
        setUser(null);
      } else {
        console.error(err);
        setErrorMsg("Failed to load GitHub user data.");
      }
    }
  };

  const clearPushResult = () => {
    setUploadSuccessUrl(null);
    setPushResult(null);
    setPushErrorMsg(null);
  };

  // Resets everything tied to "which repo is selected" — shared by both the
  // normal repo-switch path and the newly-created-repo path so they can't
  // drift out of sync with each other.
  const resetRepoScopedState = () => {
    clearPushResult();
    setRepoTree([]);
    setTreeTruncated(false);
    setSelectedDeletePaths(new Set());
    setDeleteSuccessMsg(null);
    setTreeErrorMsg(null);
    setShowDeleteRepoConfirm(false);
    setDeleteRepoConfirmText("");
    setDeleteRepoErrorMsg(null);
    setSecretWarningMsg(null);
  };

  const handleRepoSelectChange = (value: string) => {
    if (value === CREATE_NEW_REPO_VALUE) {
      setCreateRepoErrorMsg(null);
      setNewRepoName(suggestRepoName(repos));
      setNewRepoIsPrivate(false);
      setIsCreatingRepo(true);
      // The "create new repo" panel replaces the repo-scoped view entirely,
      // so anything tied to the previously-selected repo (an open file
      // manager, its loaded tree, a leftover secret-scan warning) needs to
      // be cleared here too — otherwise it stays visible behind/after the
      // panel closes, looking like stale or broken state.
      resetRepoScopedState();
      return;
    }
    setIsCreatingRepo(false);
    setSelectedRepoFullId(value);
    resetRepoScopedState();
  };

  const handleCancelCreateRepo = () => {
    setIsCreatingRepo(false);
    setCreateRepoErrorMsg(null);
  };

  const handleCreateRepo = async () => {
    const name = newRepoName.trim();
    if (!name) {
      setCreateRepoErrorMsg("Please enter a repository name.");
      return;
    }
    if (!REPO_NAME_PATTERN.test(name)) {
      setCreateRepoErrorMsg("Repository names can only contain letters, numbers, periods, hyphens and underscores.");
      return;
    }
    setIsSubmittingNewRepo(true);
    setCreateRepoErrorMsg(null);
    try {
      const repo = await createRepository(name, newRepoIsPrivate);
      trackEvent("repo_created", { is_private: newRepoIsPrivate });
      setRepos((prev: any[]) => [repo, ...prev]);
      setSelectedRepoFullId(repo.full_name);
      resetRepoScopedState();
      setIsCreatingRepo(false);
    } catch (err: any) {
      setCreateRepoErrorMsg(err.message || "Failed to create the repository.");
    } finally {
      setIsSubmittingNewRepo(false);
    }
  };

  const handleConnect = useCallback(async () => {
    // Open the popup synchronously, on the click itself — some browsers
    // (notably Safari/iOS) only treat window.open as user-initiated if it
    // happens with no `await` in between, or it gets silently blocked with
    // no error. We open a blank popup now and point it at the real URL once
    // we have it, instead of awaiting the fetch first and opening after.
    const authWindow = window.open("", "oauth_popup", "width=600,height=700");
    if (!authWindow) {
      setErrorMsg("Please allow popups to connect your GitHub account.");
      return;
    }
    try {
      trackEvent("connect_github_initiated");
      setErrorMsg(null);
      // The OAuth `state` value is generated and validated entirely
      // server-side (bound to a signed, HttpOnly cookie) — see /api/auth/url
      // and /auth/callback in server.ts. takeAuthUrl() hands back the URL that
      // the button prefetched on hover/focus/touch (src/lib/authUrl.ts), so
      // usually there is nothing left to wait for; otherwise it fetches now.
      authWindow.location.href = await takeAuthUrl();
    } catch (err) {
      console.error(err);
      setErrorMsg("Failed to start OAuth flow.");
      authWindow.close();
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } catch (err) {
      console.error(err);
    }
    repoLoadGen.current++; // stop any background page load from adding to the old account's list
    setIsLoadingMoreRepos(false);
    setRepoListError(null);
    setUser(null);
    setRepos([]);
    setSelectedSource(null);
    setExtractedFiles([]);
    clearPushResult();
    setIsCreatingRepo(false);
    setSelectedRepoFullId("");
    setErrorMsg(null);
    setView("push");
    // Disconnecting should clear anything scoped to whichever repo was
    // selected before — an open file manager and its loaded tree, delete
    // state, secret-scan warnings — so reconnecting starts from a clean
    // slate instead of showing the previous account's data.
    resetRepoScopedState();
  }, []);

  const processFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.type !== "application/zip" && !file.name.endsWith(".zip")) {
      setErrorMsg("Please select a valid ZIP file.");
      return;
    }
    setErrorMsg(null);
    setSelectedSource({ kind: "zip", name: file.name });
    clearPushResult();
    trackEvent("zip_uploaded", { size_bytes: file.size, file_name: file.name });

    setIsExtracting(true);
    try {
      const files = await extractZip(file, (fname) => setExtractingName(fname));
      setExtractedFiles(files);
    } catch (err: any) {
      console.error(err);
      setErrorMsg(err?.message || "Failed to extract ZIP.");
      setExtractedFiles([]);
      setSelectedSource(null);
    } finally {
      setIsExtracting(false);
    }
  };

  const processFolder = async (files: File[], folderName: string) => {
    if (!files || files.length === 0) return;
    setErrorMsg(null);
    setSelectedSource({ kind: "folder", name: folderName });
    clearPushResult();
    trackEvent("folder_uploaded", { file_count: files.length, folder_name: folderName });

    setIsExtracting(true);
    try {
      const extracted = await extractFolder(files, (fname) => setExtractingName(fname));
      setExtractedFiles(extracted);
    } catch (err: any) {
      console.error(err);
      setErrorMsg(err?.message || "Failed to read the selected folder.");
      setExtractedFiles([]);
      setSelectedSource(null);
    } finally {
      setIsExtracting(false);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // Reset input to allow selecting the same file again
    await processFile(file);
  };

  const handleFolderChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    const files = fileList ? Array.from(fileList) : [];
    e.target.value = ''; // Reset input to allow selecting the same folder again
    if (files.length === 0) return;
    // webkitRelativePath looks like "my-project/src/App.tsx" — take the
    // first segment as the folder's display name.
    const folderName = ((files[0] as any).webkitRelativePath || files[0].name).split("/")[0];
    await processFolder(files, folderName);
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!isDraggingFile) setIsDraggingFile(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    // Only clear once the pointer actually leaves the drop zone, not when it
    // crosses into a child element (which also fires dragleave on the parent).
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDraggingFile(false);
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDraggingFile(false);

    // A dropped folder arrives as a single DataTransferItem whose entry is a
    // directory — detect that first and walk it recursively. Otherwise fall
    // back to the plain file (ZIP) path, same as before.
    const item = e.dataTransfer.items?.[0];
    const entry = item?.kind === "file" ? item.webkitGetAsEntry?.() : null;
    if (entry && entry.isDirectory) {
      // Walking a folder's entries can take a moment before extraction even
      // starts (nothing was visibly "loading" here before, which made it
      // look like the drop had silently failed) — show feedback immediately.
      setIsReadingFolder(true);
      try {
        const files = await filesFromDataTransferItems(e.dataTransfer.items);
        await processFolder(files, entry.name);
      } finally {
        setIsReadingFolder(false);
      }
      return;
    }

    const file = e.dataTransfer.files?.[0];
    await processFile(file);
  };

  const handleUpload = async () => {
    if (!user || !selectedRepoFullId || extractedFiles.length === 0) return;
    
    // If it was already successful, open the link instead
    if (uploadSuccessUrl) {
      window.open(uploadSuccessUrl, "_blank");
      return;
    }

    setIsUploading(true);
    setPushErrorMsg(null);
    setSecretWarningMsg(null);
    setUploadProgress({ current: 0, total: 0 });
    const [owner, repo] = selectedRepoFullId.split("/");

    // Scan for and strip out secrets (API keys, tokens, .env files, private keys, etc.)
    // before pushing, so a leaked credential in the ZIP doesn't cause GitHub's push
    // protection to reject the upload.
    // sanitizeFiles is async and yields back to the event loop periodically
    // (like extractZip), so the spinner set above actually gets a chance to
    // paint before this potentially heavy scan/redaction work runs.
    let sanitizeFiles: Awaited<ReturnType<typeof loadSecretScanner>>["sanitizeFiles"];
    try {
      ({ sanitizeFiles } = await loadSecretScanner());
    } catch (err: any) {
      // The scanner is a separate download; if it cannot be fetched (offline, or
      // a deploy replaced the file) nothing has been pushed, so stop cleanly.
      console.error("Could not load the secret scanner:", err);
      setPushErrorMsg("Could not load part of the page needed to check your files. Check your connection and try again.");
      setIsUploading(false);
      return;
    }
    const { sanitized: filesToUpload, report } = await sanitizeFiles(extractedFiles);
    if (report.skippedFiles.length > 0 || report.redactedFiles.length > 0 || report.unscannedFiles.length > 0) {
      const parts: string[] = [];
      if (report.skippedFiles.length > 0) {
        parts.push(`${report.skippedFiles.length} sensitive file(s) excluded (${report.skippedFiles.join(", ")})`);
      }
      if (report.redactedFiles.length > 0) {
        parts.push(`${report.redactedFiles.length} file(s) had secrets redacted before pushing`);
      }
      if (report.unscannedFiles.length > 0) {
        parts.push(`${report.unscannedFiles.length} large file(s) were not scanned for secrets (${report.unscannedFiles.join(", ")})`);
      }
      setSecretWarningMsg(parts.join(" · "));
      if (report.skippedFiles.length > 0 || report.redactedFiles.length > 0) {
        trackEvent("secrets_sanitized", {
          skipped_count: report.skippedFiles.length,
          redacted_count: report.redactedFiles.length,
        });
      }
    }

    try {
      const commit = await uploadToGitHub(
        owner,
        repo,
        filesToUpload,
        "Upload files via ZiptoGit",
        (status, current, total) => {
          setUploadStatusMsg(status);
          setUploadProgress({ current, total });
        }
      );
      setUploadSuccessUrl(`https://github.com/${selectedRepoFullId}`);
      setPushResult({
        repo: selectedRepoFullId,
        fileCount: filesToUpload.length,
        skipped: report.skippedFiles.length,
        redacted: report.redactedFiles.length,
        commitSha: typeof commit?.sha === "string" ? commit.sha.slice(0, 7) : undefined,
        commitUrl:
          typeof commit?.html_url === "string" && commit.html_url.startsWith("https://github.com/")
            ? commit.html_url
            : undefined,
      });
      trackEvent("push_successful", { files_count: extractedFiles.length });
    } catch (err: any) {
      console.error("Upload error details:", err);
      const apiErrorMsg = err.response?.data?.message;
      setPushErrorMsg(apiErrorMsg ? `GitHub API Error: ${apiErrorMsg}` : (err.message || "An error occurred during upload."));
      trackEvent("push_failed", { error: apiErrorMsg || err.message });
    } finally {
      setIsUploading(false);
    }
  };

  // Once signed in, the visitor is about to pick a ZIP and push it. Fetch the
  // two chunks that step needs (JSZip, the secret scanner) when the browser is
  // idle, so the first extraction does not wait on a download. Signed-out
  // visitors never need them and do not pay for them.
  const isSignedIn = !!user;
  useEffect(() => {
    if (!isSignedIn) return;
    const warm = () => {
      warmZipExtractor();
      loadSecretScanner().catch(() => {});
    };
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(warm, { timeout: 5000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(warm, 2000);
    return () => window.clearTimeout(id);
  }, [isSignedIn]);

  // --- Manage (delete) existing repo files/folders --- //
  // The tree loads whenever the manage view is open for a repo (and again on
  // "Try again"). The cancelled flag drops a stale response if the repo or view
  // changes mid-request.
  useEffect(() => {
    if (view !== "manage" || !selectedRepoFullId || isCreatingRepo) return;
    let cancelled = false;
    setIsLoadingTree(true);
    setTreeErrorMsg(null);
    setDeleteSuccessMsg(null);
    setSelectedDeletePaths(new Set());
    setShowDeleteRepoConfirm(false);
    setDeleteRepoConfirmText("");
    setDeleteRepoErrorMsg(null);
    const [owner, repo] = selectedRepoFullId.split("/");
    // Fetch the tree component while the file list is in flight.
    loadRepoFileTree().catch(() => {});
    fetchRepoTree(owner, repo, defaultBranchOf(selectedRepoFullId))
      .then(({ tree, truncated }) => {
        if (cancelled) return;
        setRepoTree(tree);
        setTreeTruncated(!!truncated);
      })
      .catch((err: any) => {
        if (cancelled) return;
        console.error(err);
        setTreeErrorMsg(err.message || "Failed to load repository files.");
        setRepoTree([]);
        setTreeTruncated(false);
      })
      .finally(() => { if (!cancelled) setIsLoadingTree(false); });
    return () => { cancelled = true; };
  }, [view, selectedRepoFullId, isCreatingRepo, treeReloadKey]);

  const handleDeleteSelected = async () => {
    if (!user || !selectedRepoFullId || selectedDeletePaths.size === 0) return;
    const [owner, repo] = selectedRepoFullId.split("/");
    const pathsArray: string[] = Array.from(selectedDeletePaths);

    setIsDeleting(true);
    setTreeErrorMsg(null);
    setDeleteSuccessMsg(null);
    try {
      await deleteRepoPaths(
        owner,
        repo,
        pathsArray,
        `Delete ${pathsArray.length} item(s) via ZiptoGit`,
        (status) => setDeleteStatusMsg(status)
      );
      setDeleteSuccessMsg(`Deleted ${pathsArray.length} item(s) successfully.`);
      trackEvent("repo_files_deleted", { count: pathsArray.length });
      // Refresh the tree so the UI reflects the new state.
      const { tree, truncated } = await fetchRepoTree(owner, repo, defaultBranchOf(selectedRepoFullId));
      setRepoTree(tree);
      setTreeTruncated(!!truncated);
      setSelectedDeletePaths(new Set());
    } catch (err: any) {
      console.error("Delete error details:", err);
      setTreeErrorMsg(err.message || "Failed to delete selected items.");
      trackEvent("repo_files_delete_failed", { error: err.message });
    } finally {
      setIsDeleting(false);
      setDeleteStatusMsg("");
    }
  };

  const handleDeleteRepo = async () => {
    if (!user || !selectedRepoFullId) return;
    const [owner, repo] = selectedRepoFullId.split("/");
    if (deleteRepoConfirmText !== repo) return;

    setIsDeletingRepo(true);
    setDeleteRepoErrorMsg(null);
    try {
      await deleteRepository(owner, repo);
      trackEvent("repo_deleted");
      // Remove it from local state and reset selection since it no longer exists.
      setRepos((prev: any[]) => prev.filter((r: any) => r.full_name !== selectedRepoFullId));
      setSelectedRepoFullId("");
      setShowDeleteRepoConfirm(false);
      setDeleteRepoConfirmText("");
      setRepoTree([]);
      setSelectedDeletePaths(new Set());
    } catch (err: any) {
      console.error("Delete repo error details:", err);
      setDeleteRepoErrorMsg(err.message || "Failed to delete repository.");
      trackEvent("repo_delete_failed", { error: err.message });
    } finally {
      setIsDeletingRepo(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Derived state for the three-step push flow
  // ---------------------------------------------------------------------------
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const selectedRepoName = selectedRepoFullId ? selectedRepoFullId.split("/")[1] : "";
  const repoReady = !!selectedRepoFullId && !isCreatingRepo;
  const filesReady = !!selectedSource && !isExtracting && extractedFiles.length > 0;
  const stepStatus = (n: 1 | 2): StepStatus => {
    const done = n === 1 ? repoReady : filesReady;
    if (done) return "done";
    const firstOpen = !repoReady ? 1 : !filesReady ? 2 : 0;
    return firstOpen === n ? "current" : "upcoming";
  };
  const viewTitle = VIEWS.find((v) => v.id === view)!.label;
  const pushPct =
    uploadProgress.total > 0 ? Math.min(100, Math.round((uploadProgress.current / uploadProgress.total) * 100)) : 0;

  // Why the main button is disabled, in words, so it is never a dead end.
  const pushBlocker = isUploading
    ? null
    : isCreatingRepo
      ? "Create the new repository first, or pick an existing one."
      : !selectedRepoFullId && !selectedSource
        ? "Select a repository and add your files to continue."
        : !selectedRepoFullId
          ? "Select a repository to continue."
          : !selectedSource
            ? "Add your files to continue."
            : isExtracting
              ? "Reading your files…"
              : extractedFiles.length === 0
                ? "No files found. Remove this and add a different ZIP or folder."
                : null;

  const pushMore = () => {
    clearPushResult();
    setSelectedSource(null);
    setExtractedFiles([]);
    setErrorMsg(null);
  };

  const errorAlert = (msg: string) => <Alert variant="error" className="mt-3">{msg}</Alert>;

  const avatar = (
    <div className="w-7 h-7 rounded-full bg-tint-3 flex items-center justify-center shrink-0 text-sm font-medium text-slate-600 dark:text-slate-300 uppercase overflow-hidden">
      {user?.avatar_url ? (
        <img src={avatarSrc(user.avatar_url)} alt="" width={AVATAR_PX} height={AVATAR_PX} decoding="async" className="w-full h-full object-cover" />
      ) : (
        user?.login?.charAt(0)
      )}
    </div>
  );

  // Avatar + username, identical in the desktop sidebar and the phone card.
  const userChip = (
    <>
      {avatar}
      <span className="flex-1 min-w-0 text-sm font-medium text-slate-600 dark:text-slate-300 truncate">{user?.login}</span>
    </>
  );

  // ---------------------------------------------------------------------------
  // Repository picker (select + inline "create new"), shared by both views
  // ---------------------------------------------------------------------------
  const repoPicker = (
    <>
      <div className="relative">
        <select
          ref={repoSelectRef}
          id={repoSelectId}
          aria-labelledby={repoLabelId}
          value={isCreatingRepo ? CREATE_NEW_REPO_VALUE : (selectedRepoFullId || "")}
          onChange={(e) => handleRepoSelectChange(e.target.value)}
          className={`${FIELD} border border-field appearance-none cursor-pointer transition-colors dark:[color-scheme:dark]`}
          disabled={isUploading}
        >
          <option value="" disabled>Choose a repository…</option>
          {repos.map(r => <option key={r.id} value={r.full_name}>{r.name}</option>)}
          <option value={CREATE_NEW_REPO_VALUE}>+ Create new repository</option>
        </select>
        <div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none text-muted">
          <ChevronDown className="w-4 h-4" />
        </div>
      </div>
      {isLoadingMoreRepos && (
        <p role="status" className="mt-2 text-sm text-muted">Loading more repositories…</p>
      )}
      {repoListError && <Alert variant="error" className="mt-2">{repoListError}</Alert>}

      {isCreatingRepo && (
        <div className="mt-3 border border-edge rounded-panel p-4 bg-tint-1 transition-colors">
          <label htmlFor={newRepoNameId} className="text-sm font-medium text-muted mb-2 block">
            New repository name
          </label>
          <input
            id={newRepoNameId}
            type="text"
            aria-invalid={createRepoErrorMsg ? true : undefined}
            value={newRepoName}
            onChange={(e) => setNewRepoName(e.target.value)}
            disabled={isSubmittingNewRepo}
            placeholder="ziptogit.in_new1"
            className={`${FIELD} border border-field font-mono placeholder:text-muted mb-3`}
          />

          <div role="group" aria-label="Visibility" className="flex items-center gap-2 mb-4">
            <button
              type="button"
              onClick={() => setNewRepoIsPrivate(false)}
              aria-pressed={!newRepoIsPrivate}
              disabled={isSubmittingNewRepo}
              className={`${BTN} text-sm border transition-colors ${
                !newRepoIsPrivate
                  ? "bg-primary text-on-primary border-primary"
                  : "bg-input text-muted border-field hover:text-slate-700 dark:hover:text-slate-200"
              }`}
            >
              <Globe className="w-4 h-4" /> Public
            </button>
            <button
              type="button"
              onClick={() => setNewRepoIsPrivate(true)}
              aria-pressed={newRepoIsPrivate}
              disabled={isSubmittingNewRepo}
              className={`${BTN} text-sm border transition-colors ${
                newRepoIsPrivate
                  ? "bg-primary text-on-primary border-primary"
                  : "bg-input text-muted border-field hover:text-slate-700 dark:hover:text-slate-200"
              }`}
            >
              <Lock className="w-4 h-4" /> Private
            </button>
          </div>

          {createRepoErrorMsg && <Alert variant="error" className="mb-3">{createRepoErrorMsg}</Alert>}

          <div className="flex gap-2">
            <CancelButton onClick={handleCancelCreateRepo} disabled={isSubmittingNewRepo} />
            <button
              type="button"
              onClick={handleCreateRepo}
              disabled={isSubmittingNewRepo}
              className={`${BTN} flex-1 text-sm ${isSubmittingNewRepo ? "bg-primary text-on-primary cursor-progress" : BTN_PRIMARY}`}
            >
              {isSubmittingNewRepo ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> Creating…
                </>
              ) : (
                <>
                  <Plus className="w-4 h-4" /> Create repository
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </>
  );

  // ---------------------------------------------------------------------------
  // PUSH view: Step 1 repository, Step 2 files, Step 3 push
  // ---------------------------------------------------------------------------
  const dropZone = (
    <div
      onClick={() => !isReadingFolder && fileInputRef.current?.click()}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`border border-dashed rounded-panel p-6 sm:p-8 flex flex-col items-center justify-center text-center transition-colors ${
        isReadingFolder ? "cursor-wait" : "cursor-pointer"
      } ${
        isDraggingFile
          ? "border-primary bg-tint-2"
          : "border-field hover:border-muted hover:bg-tint-1"
      }`}
    >
      <input type="file" accept=".zip,application/zip" className="hidden" ref={fileInputRef} onChange={handleFileChange} />
      {/* Folder picking relies on the non-standard `webkitdirectory` attribute,
          which iOS Safari doesn't support and Android's file browser exposes
          inconsistently, so it is desktop-only; phones always have the ZIP path. */}
      <input
        type="file"
        className="hidden"
        ref={folderInputRef}
        onChange={handleFolderChange}
        // @ts-ignore - non-standard but widely supported attributes
        webkitdirectory=""
        directory=""
        multiple
      />
      <div className="w-12 h-12 bg-tint-2 border border-edge rounded-full flex items-center justify-center mb-3 text-slate-600 dark:text-slate-300">
        {isReadingFolder ? <Loader2 className="w-5 h-5 animate-spin" /> : <Upload className="w-5 h-5" />}
      </div>
      {isReadingFolder ? (
        <>
          <p className={`${T.prompt} mb-1`}>Reading folder…</p>
          <p className="text-muted text-sm">This can take a moment for larger projects</p>
        </>
      ) : (
        <>
          <p className={`${T.prompt} mb-1`}>{isDesktop ? "Drop a ZIP or folder here" : "Add your ZIP file"}</p>
          <p className="text-muted text-sm mb-4">
            {isDesktop ? "ZIP archive or project folder, up to 50MB" : "ZIP archive, up to 50MB"}
          </p>
          {/* The whole zone is clickable; this button is the visible, keyboard-reachable
              way in. Its click bubbles up to the zone, so no handler of its own. */}
          <button type="button" className={`${BTN} ${BTN_SECONDARY} text-sm`}>
            <FileArchive className="w-4 h-4" /> Choose ZIP file
          </button>
          {isDesktop && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                folderInputRef.current?.click();
              }}
              className="mt-2 h-11 px-4 inline-flex items-center gap-2 text-sm text-muted hover:text-ink dark:hover:text-white hover:underline underline-offset-4 transition-colors"
            >
              <Folder className="w-4 h-4" /> or select a folder
            </button>
          )}
        </>
      )}
    </div>
  );

  const selectedFileCard = selectedSource && (
    <div className="border border-edge rounded-panel p-4 bg-tint-1 flex items-center justify-between transition-colors">
      <div className="flex items-center gap-3 overflow-hidden">
        <div className="w-10 h-10 rounded-control bg-tint-2 text-slate-600 dark:text-slate-300 flex items-center justify-center shrink-0">
          {selectedSource.kind === "folder" ? <Folder className="w-5 h-5" /> : <FileArchive className="w-5 h-5" />}
        </div>
        <div className="overflow-hidden">
          <p className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">{selectedSource.name}</p>
          <p className="text-sm text-muted truncate">
            {isExtracting
              ? `Reading ${extractingName || "files"}…`
              : `${extractedFiles.length} file${extractedFiles.length === 1 ? "" : "s"} ready`}
          </p>
        </div>
      </div>
      <button
        type="button"
        aria-label="Remove selected files"
        disabled={isUploading}
        onClick={() => {
          setSelectedSource(null);
          setExtractedFiles([]);
          clearPushResult();
        }}
        className="h-11 w-11 -mr-3 inline-flex items-center justify-center text-muted hover:text-slate-700 dark:hover:text-slate-200 hover:bg-tint-2 rounded-control transition-colors shrink-0 disabled:opacity-50"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );

  const pushArea = pushResult ? (
    <div role="status" className="rounded-panel border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/10 p-4">
      <div className="flex items-start gap-3">
        <CheckCircle className="w-5 h-5 mt-0.5 text-emerald-700 dark:text-emerald-400 shrink-0" />
        <div className="min-w-0">
          <p className="text-base font-medium text-emerald-900 dark:text-emerald-200 break-words">
            Pushed {pushResult.fileCount} file{pushResult.fileCount === 1 ? "" : "s"} to {pushResult.repo}
          </p>
          <p className="text-sm text-emerald-800 dark:text-emerald-300 mt-0.5">
            {[
              pushResult.commitSha ? `Commit ${pushResult.commitSha}` : null,
              pushResult.skipped > 0 ? `${pushResult.skipped} sensitive file${pushResult.skipped === 1 ? "" : "s"} excluded` : null,
              pushResult.redacted > 0 ? `${pushResult.redacted} file${pushResult.redacted === 1 ? "" : "s"} redacted` : null,
            ].filter(Boolean).join(" · ") || "Your files are on GitHub."}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 mt-4">
        <a
          href={uploadSuccessUrl || `https://github.com/${pushResult.repo}`}
          target="_blank"
          rel="noopener noreferrer"
          className={`${BTN} text-sm bg-primary text-on-primary hover:bg-primary-hover transition-colors`}
        >
          View on GitHub <ExternalLink className="w-4 h-4" />
        </a>
        {pushResult.commitUrl && (
          <a
            href={pushResult.commitUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={`${BTN} ${BTN_SECONDARY} text-sm`}
          >
            View commit <ExternalLink className="w-4 h-4" />
          </a>
        )}
        <button type="button" onClick={pushMore} className={`${BTN} ${BTN_SECONDARY} text-sm`}>
          Push more files
        </button>
      </div>
    </div>
  ) : (
    <>
      <button
        onClick={handleUpload}
        disabled={isUploading || isExtracting || !selectedSource || extractedFiles.length === 0 || !selectedRepoFullId || isCreatingRepo}
        aria-describedby={pushBlocker ? "push-hint" : undefined}
        className={`${BTN} w-full text-base ${
          isUploading ? "bg-primary text-on-primary cursor-progress" : BTN_CTA
        }`}
      >
        {isUploading ? (
          <>
            <Loader2 className="w-5 h-5 animate-spin" /> Pushing…
          </>
        ) : (
          "Push files"
        )}
      </button>
      {isUploading && (
        <div className="mt-4" role="progressbar" aria-label="Upload progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pushPct}>
          <div className="h-2 rounded-full bg-tint-3 overflow-hidden">
            <div className="h-full rounded-full bg-primary transition-[width] duration-200" style={{ width: `${pushPct}%` }} />
          </div>
          <p className="mt-2 text-sm text-muted flex justify-between gap-3">
            <span className="truncate">{uploadStatusMsg || "Starting…"}</span>
            <span className="tabular-nums">{pushPct}%</span>
          </p>
        </div>
      )}
      {pushBlocker && (
        <p id="push-hint" className="mt-3 text-sm text-center text-muted">
          {pushBlocker}
        </p>
      )}
      {pushErrorMsg && errorAlert(pushErrorMsg)}
    </>
  );

  const pushView = (
    <>
      <section className="mb-8" aria-labelledby={repoLabelId}>
        <StepHeader n={1} title="Repository" status={stepStatus(1)} titleId={repoLabelId} />
        {repoPicker}
      </section>

      <section className="mb-8" aria-labelledby={filesLabelId}>
        <StepHeader n={2} title="Files" status={stepStatus(2)} titleId={filesLabelId} />
        {!selectedSource ? dropZone : selectedFileCard}
        {errorMsg && errorAlert(errorMsg)}
      </section>

      {/* No third step header: the button is the destination of steps 1 and 2, and
          it names itself. */}
      <section aria-label="Push files">
        {pushArea}
        {secretWarningMsg && <Alert variant="warning" className="mt-3">{secretWarningMsg}</Alert>}
        {!pushResult && (
          <p className="mt-3 text-sm flex items-start gap-2 text-muted">
            <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0 text-emerald-700 dark:text-emerald-400" />
            <span>Secret scanning is on: sensitive files are skipped and secrets redacted before anything is pushed.</span>
          </p>
        )}
      </section>
    </>
  );

  // ---------------------------------------------------------------------------
  // MANAGE view: browse/delete files, plus the one and only "delete repository"
  // ---------------------------------------------------------------------------
  const manageView = (
    <>
      <section className="mb-8">
        {/* Same heading as Push step 1 (T.title, 16/600, mb-3), minus the number:
            these two views are not a sequence. */}
        <h2 className={`${T.title} text-slate-900 dark:text-slate-100 mb-3`}>
          <label id={repoLabelId} htmlFor={repoSelectId}>Repository</label>
        </h2>
        {repoPicker}
      </section>

      {!repoReady ? (
        <p className="text-sm text-muted py-8 text-center">
          {isCreatingRepo ? "Create the repository to manage its files." : "Select a repository to see its files."}
        </p>
      ) : (
        <>
          <section aria-labelledby="files-title">
            <h2 id="files-title" className={`${T.title} text-slate-900 dark:text-slate-100 mb-3 break-words`}>
              Files in {selectedRepoName}
            </h2>
            <div className="border border-edge rounded-panel p-4 bg-tint-1 transition-colors">
              {isLoadingTree ? (
                <div className="flex items-center gap-2 text-sm text-muted py-4 justify-center">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading repository files…
                </div>
              ) : treeErrorMsg ? (
                <div className="py-2">
                  <Alert variant="error" className="mb-3">{treeErrorMsg}</Alert>
                  <button
                    type="button"
                    onClick={() => setTreeReloadKey((k) => k + 1)}
                    className={`${BTN} ${BTN_SECONDARY} text-sm`}
                  >
                    Try again
                  </button>
                </div>
              ) : repoTree.length === 0 ? (
                <p className="text-sm text-muted py-2 text-center">This repository has no files yet.</p>
              ) : (
                <>
                  <p className="text-sm text-muted mb-2">
                    Check files or folders to mark them for deletion.
                  </p>
                  {treeTruncated && (
                    <Alert variant="warning" className="mb-3">
                      This repository is too large for GitHub to list completely, so some files are not shown here.
                      Deleting a folder still removes everything inside it.
                    </Alert>
                  )}
                  <Suspense
                    fallback={
                      <div className="flex items-center justify-center py-6 mb-3" role="status">
                        <Loader2 className="w-5 h-5 text-muted animate-spin" />
                        <span className="sr-only">Loading files…</span>
                      </div>
                    }
                  >
                    <RepoFileTree entries={repoTree} selected={selectedDeletePaths} onChange={setSelectedDeletePaths} />
                  </Suspense>
                  {deleteSuccessMsg && (
                    <Alert variant="success" className="mb-3">{deleteSuccessMsg}</Alert>
                  )}
                  <button
                    type="button"
                    onClick={handleDeleteSelected}
                    disabled={selectedDeletePaths.size === 0 || isDeleting}
                    className={`${BTN} w-full text-sm ${
                      isDeleting
                        ? "border border-red-500 dark:border-red-400/60 text-red-700 dark:text-red-300 cursor-progress"
                        : BTN_DANGER_OUTLINE
                    }`}
                  >
                    {isDeleting ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" /> {deleteStatusMsg || "Deleting…"}
                      </>
                    ) : (
                      <>
                        <Trash2 className="w-4 h-4" />
                        Delete {selectedDeletePaths.size > 0 ? `${selectedDeletePaths.size} selected` : "selected"}
                      </>
                    )}
                  </button>
                </>
              )}
            </div>
          </section>

          {!isLoadingTree && (
            <section aria-labelledby="danger-title" className="mt-8 rounded-panel border border-red-500 dark:border-red-400/60 p-4">
              <h2 id="danger-title" className={`${T.title} text-red-700 dark:text-red-400 mb-1`}>
                Danger zone
              </h2>
              {!showDeleteRepoConfirm ? (
                <>
                  <p className="text-sm text-muted mb-3">
                    Permanently delete <span className="font-medium text-slate-900 dark:text-slate-100">{selectedRepoName}</span> from GitHub. This can’t be undone.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setShowDeleteRepoConfirm(true);
                      setDeleteRepoConfirmText("");
                      setDeleteRepoErrorMsg(null);
                    }}
                    className={`${BTN} text-sm ${BTN_DANGER}`}
                  >
                    Delete repository…
                  </button>
                </>
              ) : (
                <div>
                  {/* One message, in the danger zone's own red frame. (There used to be
                      a red error Alert saying "can't be undone" and then the
                      instruction: the same warning twice, in the failure colour.
                      Alert error is now only for an actual failure, below.) */}
                  <p id={deleteConfirmHintId} className="text-sm text-muted mb-3">
                    This permanently deletes the repository and can’t be undone. Type <span className="font-mono text-slate-900 dark:text-slate-100">{selectedRepoName}</span> to confirm.
                  </p>
                  <input
                    type="text"
                    aria-label="Repository name to confirm deletion"
                    aria-describedby={deleteConfirmHintId}
                    value={deleteRepoConfirmText}
                    onChange={(e) => setDeleteRepoConfirmText(e.target.value)}
                    placeholder={selectedRepoName}
                    className={`${FIELD} border border-red-500 dark:border-red-400 font-mono placeholder:text-muted mb-3`}
                    disabled={isDeletingRepo}
                  />
                  {deleteRepoErrorMsg && <Alert variant="error" className="mb-3">{deleteRepoErrorMsg}</Alert>}
                  <div className="flex gap-2">
                    <CancelButton
                      onClick={() => {
                        setShowDeleteRepoConfirm(false);
                        setDeleteRepoConfirmText("");
                        setDeleteRepoErrorMsg(null);
                      }}
                      disabled={isDeletingRepo}
                    />
                    <button
                      type="button"
                      onClick={handleDeleteRepo}
                      disabled={deleteRepoConfirmText !== selectedRepoName || isDeletingRepo}
                      className={`${BTN} flex-1 text-sm ${
                        isDeletingRepo ? "bg-red-700 text-white cursor-progress" : BTN_DANGER
                      }`}
                    >
                      {isDeletingRepo ? (
                        <><Loader2 className="w-4 h-4 animate-spin" /> Deleting…</>
                      ) : (
                        "Delete forever"
                      )}
                    </button>
                  </div>
                </div>
              )}
            </section>
          )}
        </>
      )}
    </>
  );

  const activeView = view === "push" ? pushView : manageView;

  // ---------------------------------------------------------------------------
  // Signed-out content (copy differs per layout; the trust line is shared)
  // ---------------------------------------------------------------------------
  const connectButton = (
    <button
      onClick={handleConnect}
      onPointerEnter={prefetchAuthUrl}
      onPointerDown={prefetchAuthUrl}
      onFocus={prefetchAuthUrl}
      className={`${CTRL} px-8 text-base font-medium inline-flex justify-center items-center gap-2 bg-primary text-on-primary transition-colors hover:bg-primary-hover`}
    >
      <Github className="w-5 h-5" /> Connect GitHub
    </button>
  );

  // The signed-out panel. One element for every width (the card around it is
  // responsive in CSS, see below), so the heading, copy, button and trust line
  // cannot differ between phone and desktop, and the prerendered HTML is right
  // at any viewport. Left-aligned; the button is full width below lg.
  const signedOutPanel = (
    <>
      <h1 className={`${T.h1} text-ink dark:text-white mb-2`}>Connect your GitHub account</h1>
      <p className={`${T.prose} text-muted max-w-copy mb-8`}>
        Securely push ZIP contents directly to your repositories without needing a local Git environment.
      </p>
      <div className="w-full flex flex-col [&>button]:w-full lg:w-auto lg:block lg:[&>button]:w-auto">{connectButton}</div>
      {errorMsg && <div className="w-full">{errorAlert(errorMsg)}</div>}
      <p className="mt-6 flex items-start gap-2 text-sm text-muted max-w-copy">
        <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0 text-emerald-700 dark:text-emerald-400" />
        <span>Files are scanned for secrets in your browser before anything is pushed.</span>
      </p>
    </>
  );

  // ===========================================================================
  // DESKTOP: sidebar navigation + one main panel
  // ===========================================================================
  // Signed out, or still checking: ONE card for every width. It used to be a
  // desktop card and a phone card chosen with isDesktop (a JS media query),
  // which cannot be known when the page is prerendered, so the layout is now
  // plain CSS: two columns from lg, one below, terminal panel from lg up.
  if (!user) {
    return (
      <div data-auth-card className={`flex w-full max-w-app-sm sm:max-w-content lg:max-w-app lg:min-h-140 overflow-hidden transition-colors duration-200 ${CARD_EDGE}`}>
        {isCheckingAuth ? (
          <div className="flex-1 flex items-center justify-center py-14 lg:py-0" role="status">
            <Loader2 className="w-6 h-6 text-muted animate-spin" />
            <span className="sr-only">Loading…</span>
          </div>
        ) : (
          <div data-signed-out className="flex-1 grid lg:grid-cols-2">
            <div className="flex flex-col items-start justify-center p-6 lg:p-12">
              {signedOutPanel}
            </div>
            <div className="hidden lg:flex items-center bg-tint-1 border-l border-edge-subtle p-8">
              <ZipToGitTerminal />
            </div>
          </div>
        )}
      </div>
    );
  }

  if (isDesktop) {
    return (
      <div className={`flex w-full max-w-app min-h-140 overflow-hidden transition-colors duration-200 ${CARD_EDGE}`}>
        {/* Sidebar: navigation between the two views, plus the account */}
        <aside className="w-52 shrink-0 bg-tint-1 border-r border-edge-subtle p-4 flex flex-col transition-colors">
          <nav aria-label="Dashboard" className="flex flex-col gap-1">
            {VIEWS.map(({ id, label, icon }) => (
              <SidebarItem key={id} active={view === id} icon={icon} onClick={() => setView(id)}>
                {label}
              </SidebarItem>
            ))}
          </nav>

          <div className="flex-1" />

          <div className="mt-2 pt-3 border-t border-edge-subtle flex items-center gap-3 px-1">
            {userChip}
            <button
              onClick={logout}
              aria-label="Disconnect GitHub account"
              title="Disconnect"
              className="h-11 w-11 -mr-3 inline-flex items-center justify-center text-muted hover:text-slate-700 dark:hover:text-slate-200 hover:bg-tint-3 rounded-control transition-colors shrink-0"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </aside>

        {/* Main panel */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="p-8">
            <h1 className={`${T.h1} text-ink dark:text-white mb-6`}>{viewTitle}</h1>
            {activeView}
          </div>
        </div>
      </div>
    );
  }

  // ===========================================================================
  // MOBILE / TABLET: one column, segmented view switch, account row at the end
  // ===========================================================================
  return (
    <div className={`w-full max-w-app-sm sm:max-w-content overflow-hidden transition-colors duration-200 ${CARD_EDGE}`}>
      <div className="p-6 bg-surface">
        {/* The switch below already names the active view, so the h1 is
            for screen readers only: no banner repeating it. */}
        <h1 className="sr-only">{viewTitle}</h1>
        <div role="group" aria-label="Section" className="grid grid-cols-2 gap-1 p-1 rounded-control bg-tint-2 mb-6">
          {VIEWS.map(({ id: v, label }) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={`h-11 rounded-control text-sm font-medium transition-colors ${
                view === v
                  ? "bg-lift text-ink dark:text-white elevation-control"
                  : "text-muted hover:text-slate-900 dark:hover:text-white"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {activeView}

        <div className="mt-8 pt-4 border-t border-edge-subtle flex items-center gap-3">
          {userChip}
          <button
            onClick={logout}
            className="h-11 px-3 -mr-3 inline-flex items-center gap-2 text-sm text-muted hover:text-slate-900 dark:hover:text-white transition-colors"
          >
            <LogOut className="w-4 h-4" />
            Disconnect
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Content Pages --- //
// Bump this whenever the Privacy policy copy below actually changes — it must
// never be computed at render time (was `new Date().toLocaleDateString()`,
// which falsely told every visitor the policy was updated that same day).
const PRIVACY_LAST_UPDATED = "August 10, 2026";
// Same rule for the Terms. Set to the Privacy date because the two were last
// edited together; change it whenever the Terms copy changes.
const TERMS_LAST_UPDATED = "August 10, 2026";

function PrivacyPage() {
  return (
    <PageLayout title={PAGE_TITLES["/privacy"]}>
      <div className={`w-full max-w-content ${CARD_EDGE} p-6 sm:p-12 ${T.prose}`}>
        <h1 className={`${T.h1} text-ink dark:text-white mb-6`}>Privacy policy</h1>
        <p className="mb-4 text-sm text-muted">Last updated: {PRIVACY_LAST_UPDATED}</p>
        <h2 className={`${T.h2} mt-6 mb-3`}>1. Information we collect</h2>
        <p className="mb-4">ZiptoGit requests OAuth access to your GitHub account to push files directly to your repositories. We do not store your repository contents or your source code on our servers.</p>
        <h2 className={`${T.h2} mt-6 mb-3`}>2. How we use information</h2>
        <p className="mb-4">Your GitHub access token is never stored in your browser. It is held only in a secure, HttpOnly server-side session used to interface with the GitHub API on your behalf to perform ZIP extraction and commit operations.</p>
        <h2 className={`${T.h2} mt-6 mb-3`}>3. Third-party services</h2>
        <p className="mb-4">We use Google Analytics to monitor usage and improve the tool. We do not sell your data.</p>
      </div>
    </PageLayout>
  );
}

function TermsPage() {
  return (
    <PageLayout title={PAGE_TITLES["/terms"]}>
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
    <PageLayout title={PAGE_TITLES["/contact"]}>
      <div className={`w-full max-w-content ${CARD_EDGE} p-6 sm:p-12 ${T.prose}`}>
        <h1 className={`${T.h1} text-ink dark:text-white mb-6`}>Contact</h1>
        <p className="mb-8">Have a question, feedback, or need support? Reach out directly.</p>

        <div className="inline-flex flex-col items-start gap-2 p-6 bg-tint-1 rounded-panel border border-edge">
          <span className={`${T.eyebrow} text-muted`}>Support email</span>
          <a href="mailto:siteget1234@gmail.com" className="inline-flex items-center min-h-11 text-lg font-medium text-ink dark:text-white hover:underline">siteget1234@gmail.com</a>
        </div>
      </div>
    </PageLayout>
  );
}

const HOW_IT_WORKS_STEPS = [
  {
    title: "Connect GitHub",
    body: "Sign in with your GitHub account. Your access token is kept in a secure server-side session — never in your browser’s storage.",
  },
  {
    title: "Upload ZIP",
    body: "Add your AI Studio ZIP export by dropping it in or choosing it from your files. The files are unzipped and scanned for secrets right in your browser before anything leaves your device.",
  },
  {
    title: "Sync directly",
    body: "We push the extracted files directly back into your selected repository using the GitHub API in one clean commit.",
  },
];

function HowItWorksPage() {
  return (
    <PageLayout title={PAGE_TITLES["/how-it-works"]}>
      <div className={`w-full max-w-content ${CARD_EDGE} p-6 sm:p-12 ${T.prose}`}>
        <h1 className={`${T.h1} text-ink dark:text-white mb-6`}>How it works</h1>
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
    { q: "Is my code secure?", a: "Yes. Your ZIP is extracted and scanned for secrets right in your browser. The push to GitHub is then proxied through our server using a secure, HttpOnly session — your GitHub access token is never sent to or stored in your browser." },
    { q: "What does ZiptoGit cost?", a: "It is currently completely free to use." },
    { q: "Can I use it for private repositories?", a: "Yes. When you authenticate via OAuth, you grant the app access to read and commit to repositories you have permissions for." }
  ];

  return (
    <PageLayout title={PAGE_TITLES["/faq"]}>
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

// --- Main App / Router --- //
// The routes on their own, so the prerender step (src/entry-server.tsx) can
// render them inside a StaticRouter while the browser uses BrowserRouter.
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<HomeLayout />} />
      <Route path="/how-it-works" element={<HowItWorksPage />} />
      <Route path="/privacy" element={<PrivacyPage />} />
      <Route path="/terms" element={<TermsPage />} />
      <Route path="/faq" element={<FAQPage />} />
      <Route path="/contact" element={<ContactPage />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
