import { useState, useEffect, useLayoutEffect, useRef, useCallback, Fragment, useSyncExternalStore } from "react";
import { BrowserRouter, Routes, Route, Link, useLocation, useNavigationType } from "react-router-dom";
import type { BootstrapData } from "./lib/github";
import { trackEvent, trackPageView } from "./lib/analytics";
import { prefetchAuthUrl, takeAuthUrl } from "./lib/authUrl";
import { readSessionFlag, clearSessionFlag, sessionPending, endSessionPending } from "./lib/session";
import { findPublicPage, NOT_FOUND_PAGE, PAGE_TITLES, SITE_ORIGIN } from "./routes";
import { SECRET_SCAN_NOTE } from "./lib/uploadLimits";
import { Github, Loader2, CheckCircle, ShieldCheck, Sun, Moon, Menu, X } from "lucide-react";
import { Alert, CARD_EDGE, CTRL, StepBadge, T, useMediaQuery } from "./components/ui";

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
    trackPageView(page.path === "/" ? "Home" : PAGE_TITLES[page.path as keyof typeof PAGE_TITLES] ?? "Page not found");
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

// --- Home screen shell: full-width desktop layout with the app card
// centered in the middle of the page. --- //
function HomeLayout() {
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

// One-pass demo of what the app does (extract -> scan -> commit -> push) for the
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
  const [tick, setTick] = useState(0);
  const finished = reduceMotion || tick === TERMINAL_STAGES.length;
  const stage = finished ? TERMINAL_STAGES.length - 1 : tick;
  const running = !finished && isShown && inView && pageVisible;
  useEffect(() => {
    if (!running) return;
    const id = window.setTimeout(() => setTick(tick + 1), 1800);
    return () => window.clearTimeout(id);
  }, [running, tick]);

  return (
    <div
      ref={rootRef}
      aria-hidden="true"
      // ztg-paused (index.css) freezes the cursor blink and the pulse ring while
      // off screen. Not applied for reduced motion: there every animation is
      // already collapsed to its end state, and freezing would pin it at the start.
      className={`w-full rounded-panel bg-ink dark:bg-slate-950 border border-edge overflow-hidden font-system-mono text-sm text-slate-300 select-none${
        !reduceMotion && !(inView && pageVisible) ? " ztg-paused" : ""
      }`}
    >
      <div className="px-4 py-3 border-b border-white/10 text-slate-400 truncate">my-project.zip → you/my-project</div>
      {/* The panel is always its finished height. Every line is in the layout from
          the first paint; a line that has not been "printed" yet is only
          visibility:hidden (it keeps its space), and printing it plays an
          opacity + transform animation. Nothing is added or removed, so the
          card, the vertically centred panel and the stage bar never move
          (no layout shift).
          The hidden copy holds the same text, so a line that wraps at a narrow
          width reserves the same height as the visible one. */}
      <div className="p-4 space-y-2">
        <p><span className="text-emerald-400">$</span> ziptogit push my-project.zip</p>
        <div className="flex flex-wrap gap-2 py-1">
          {TERMINAL_FILES.map((f, i) => (
            <span
              key={f}
              style={{ animation: `ztg-chip-in 420ms ease-out ${i * 140}ms both` }}
              className="px-2 py-1 rounded-control bg-white/10 text-slate-200"
            >
              {f}
            </span>
          ))}
        </div>
        {TERMINAL_LINES.map((l) => {
          const shown = stage >= l.at;
          return (
            <p
              key={l.text}
              style={shown ? { animation: "ztg-line-in 300ms ease-out both" } : undefined}
              className={`${l.ok ? "text-emerald-400" : "text-slate-300"}${shown ? "" : " invisible"}`}
            >
              {l.ok ? "✓" : "›"} {l.text}
            </p>
          );
        })}
        <div className={`flex items-center gap-3 pt-1${stage >= 2 ? "" : " invisible"}`}>
          <span
            style={stage >= 2 ? { animation: "ztg-node-pop 450ms ease-out both" } : undefined}
            className="w-3 h-3 rounded-full bg-emerald-400 shrink-0"
          />
          <span className="text-slate-200 truncate">Upload files via ZiptoGit</span>
          <span className={`text-slate-400${stage >= 3 ? "" : " invisible"}`}>a1b2c3d</span>
        </div>
        <span style={finished ? undefined : { animation: "ztg-blink 1s steps(1) infinite" }} className="inline-block w-2 h-4 bg-slate-300 align-middle" />
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

function ZipUploader() {
  const [account, setAccount] = useState<{
    Dashboard: typeof import("./Dashboard").default;
    data: BootstrapData;
  } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Start with the signed-out card so hydration matches the prerendered HTML.
  const [isCheckingAuth, setIsCheckingAuth] = useState(false);
  const checkAtMount = useRef<boolean | null>(null);

  useLayoutEffect(() => {
    let requestId = 0;

    const loadAccount = async () => {
      const id = ++requestId;
      setAccount(null);
      setIsCheckingAuth(true);
      setErrorMsg(null);
      // The head script hides the hero while bootstrap is in flight. Switch
      // that CSS loading state to React's spinner before the next paint.
      endSessionPending();

      try {
        const { default: Dashboard, fetchBootstrap } = await import("./Dashboard");
        if (id !== requestId) return;
        const data = await fetchBootstrap();
        if (id === requestId) setAccount({ Dashboard, data });
      } catch (err) {
        if (id !== requestId) return;
        if ((err as { status?: number })?.status === 401) {
          clearSessionFlag();
        } else {
          console.error(err);
          setErrorMsg("Failed to load GitHub user data.");
        }
      } finally {
        if (id === requestId) setIsCheckingAuth(false);
      }
    };

    // Preserve the head script's verdict if a fast 401 already cleared the
    // cookie, including when Strict Mode runs this effect twice.
    checkAtMount.current ??= sessionPending() || readSessionFlag();
    if (checkAtMount.current) void loadAccount();

    const handleMessage = (event: MessageEvent) => {
      // The server validates OAuth state before posting this notification.
      if (event.origin === window.location.origin && event.data?.type === "OAUTH_AUTH_SUCCESS") {
        void loadAccount();
      }
    };

    window.addEventListener("message", handleMessage);
    return () => {
      requestId++;
      window.removeEventListener("message", handleMessage);
    };
  }, []);

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

  if (account) {
    const { Dashboard, data } = account;
    return <Dashboard account={data} onDisconnect={() => setAccount(null)} />;
  }

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
      {errorMsg && <div className="w-full"><Alert variant="error" className="mt-3">{errorMsg}</Alert></div>}
      <p className="mt-6 flex items-start gap-2 text-sm text-muted max-w-copy">
        <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0 text-emerald-700 dark:text-emerald-400" />
        <span>{SECRET_SCAN_NOTE}</span>
      </p>
    </>
  );

  return (
    <div
      data-auth-card
      data-auth-loading={isCheckingAuth ? "" : undefined}
      className={`flex w-full max-w-app-sm sm:max-w-content lg:max-w-app lg:min-h-140 overflow-hidden transition-colors duration-200 ${CARD_EDGE}`}
    >
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

// --- Content Pages --- //
// Bump this whenever the Privacy policy copy below actually changes — it must
// never be computed at render time (was `new Date().toLocaleDateString()`,
// which falsely told every visitor the policy was updated that same day).
const PRIVACY_LAST_UPDATED = "November 18, 2026";
// Change this date whenever the Terms copy changes.
const TERMS_LAST_UPDATED = "August 10, 2026";

function PrivacyPage() {
  return (
    <PageLayout>
      <div className={`w-full max-w-content ${CARD_EDGE} p-6 sm:p-12 ${T.prose}`}>
        <h1 className={`${T.h1} text-ink dark:text-white mb-6`}>Privacy policy</h1>
        <p className="mb-4 text-sm text-muted">Last updated: {PRIVACY_LAST_UPDATED}</p>
        <h2 className={`${T.h2} mt-6 mb-3`}>1. Information we collect</h2>
        <p className="mb-4">ZiptoGit requests OAuth access to your GitHub account to push files directly to your repositories. We do not store your repository contents or your source code on our servers.</p>
        <h2 className={`${T.h2} mt-6 mb-3`}>2. How we use information</h2>
        <p className="mb-4">Your browser stores your GitHub access token in a signed HttpOnly session cookie. HttpOnly prevents page scripts from reading it. The server uses the cookie to make GitHub API requests on your behalf. The cookie expires after 30 days or is cleared when you disconnect.</p>
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
          <a href="mailto:siteget1234@gmail.com" className="inline-flex items-center min-h-11 text-lg font-medium text-ink dark:text-white hover:underline">siteget1234@gmail.com</a>
        </div>
      </div>
    </PageLayout>
  );
}

const HOW_IT_WORKS_STEPS = [
  {
    title: "Connect GitHub",
    body: "Sign in with your GitHub account. Your browser keeps the access token in an HttpOnly cookie for the server to use when making GitHub API requests.",
  },
  {
    title: "Upload ZIP",
    body: `Add your AI Studio ZIP export by dropping it in or choosing it from your files. ZiptoGit extracts it in your browser. ${SECRET_SCAN_NOTE}`,
  },
  {
    title: "Sync directly",
    body: "We push the extracted files directly back into your selected repository using the GitHub API in one clean commit.",
  },
];

function HowItWorksPage() {
  return (
    <PageLayout>
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
    { q: "How are my files and GitHub token handled?", a: `ZiptoGit extracts your ZIP in your browser. ${SECRET_SCAN_NOTE} The server sends your files to GitHub using the access token from your browser’s HttpOnly session cookie.` },
    { q: "What does ZiptoGit cost?", a: "It is currently completely free to use." },
    { q: "Can I use it for private repositories?", a: "Yes. When you authenticate via OAuth, you grant the app access to read and commit to repositories you have permissions for." }
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
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<HomeLayout />} />
      <Route path="/how-it-works" element={<HowItWorksPage />} />
      <Route path="/privacy" element={<PrivacyPage />} />
      <Route path="/terms" element={<TermsPage />} />
      <Route path="/faq" element={<FAQPage />} />
      <Route path="/contact" element={<ContactPage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <RouteEffects />
      <AppRoutes />
    </BrowserRouter>
  );
}
