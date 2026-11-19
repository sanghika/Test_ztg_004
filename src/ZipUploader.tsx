import { useState, useEffect, useLayoutEffect, useRef, useCallback, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import type { BootstrapData } from "./lib/github";
import { trackEvent } from "./lib/analytics";
import { prefetchAuthUrl, takeAuthUrl, takeDeleteAuthorizationUrl } from "./lib/authUrl";
import { readSessionFlag, clearSessionFlag, sessionPending, endSessionPending } from "./lib/session";
import { HOME_HEADING } from "./routes";
import { SECRET_SCAN_NOTE } from "./lib/uploadLimits";
import { Github, Loader2, CheckCircle, ShieldCheck } from "lucide-react";
import { Alert, CARD_EDGE, CTRL, T, useMediaQuery } from "./components/ui";

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

export default function ZipUploader() {
  const [account, setAccount] = useState<{
    Dashboard: typeof import("./Dashboard").default;
    data: BootstrapData;
  } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Start with the signed-out card so hydration matches the prerendered HTML.
  const [isCheckingAuth, setIsCheckingAuth] = useState(false);
  const [accountLoadFailed, setAccountLoadFailed] = useState(false);
  const checkAtMount = useRef<boolean | null>(null);
  const accountRequestId = useRef(0);
  const oauthPopup = useRef<{ window: Window; deletion: boolean } | null>(null);
  const [deleteAuthorizationError, setDeleteAuthorizationError] = useState<string | null>(null);

  const loadAccount = useCallback(async (refreshPermissions = false) => {
    const id = ++accountRequestId.current;
    if (!refreshPermissions) {
      setAccount(null);
      setIsCheckingAuth(true);
    }
    setErrorMsg(null);
    setAccountLoadFailed(false);
    // Switch from the head script's pending state to React's loading state.
    endSessionPending();

    try {
      const { default: Dashboard, fetchBootstrap } = await import("./Dashboard");
      if (id !== accountRequestId.current) return;
      const data = await fetchBootstrap();
      if (id === accountRequestId.current) setAccount({ Dashboard, data });
    } catch (err) {
      if (id !== accountRequestId.current) return;
      if ((err as { status?: number })?.status === 401) {
        clearSessionFlag();
        setAccount(null);
      } else if (refreshPermissions) {
        setDeleteAuthorizationError("Couldn’t refresh GitHub permissions. Reload the page to check them.");
      } else {
        setAccountLoadFailed(true);
      }
    } finally {
      if (id === accountRequestId.current) setIsCheckingAuth(false);
    }
  }, []);

  useLayoutEffect(() => {
    // Preserve the head script's verdict if a fast 401 already cleared the
    // cookie, including when Strict Mode runs this effect twice.
    checkAtMount.current ??= sessionPending() || readSessionFlag();
    if (checkAtMount.current) void loadAccount();

    const handleMessage = (event: MessageEvent) => {
      // The server validates OAuth state before posting this notification.
      const popup = oauthPopup.current;
      if (popup && event.source === popup.window && event.origin === window.location.origin && event.data?.type === "OAUTH_AUTH_SUCCESS") {
        oauthPopup.current = null;
        void loadAccount(popup.deletion);
      }
    };

    window.addEventListener("message", handleMessage);
    return () => {
      accountRequestId.current += 1;
      window.removeEventListener("message", handleMessage);
    };
  }, [loadAccount]);

  const openGitHub = useCallback(async (deletion = false) => {
    const showError = deletion ? setDeleteAuthorizationError : setErrorMsg;
    // Open the popup synchronously, on the click itself — some browsers
    // (notably Safari/iOS) only treat window.open as user-initiated if it
    // happens with no `await` in between, or it gets silently blocked with
    // no error. We open a blank popup now and point it at the real URL once
    // we have it, instead of awaiting the fetch first and opening after.
    const authWindow = window.open("", "_blank", "width=600,height=700");
    if (!authWindow) {
      showError("Please allow popups to authorize access with GitHub.");
      return;
    }
    oauthPopup.current?.window.close();
    const popup = { window: authWindow, deletion };
    oauthPopup.current = popup;
    try {
      if (!deletion) trackEvent("connect_github_initiated");
      showError(null);
      // The OAuth `state` value is generated and validated entirely
      // server-side (bound to a signed, HttpOnly cookie) — see /api/auth/url
      // and /auth/callback in server.ts. takeAuthUrl() hands back the URL that
      // the button prefetched on hover/focus/touch (src/lib/authUrl.ts), so
      // usually there is nothing left to wait for; otherwise it fetches now.
      const url = await (deletion ? takeDeleteAuthorizationUrl() : takeAuthUrl());
      if (oauthPopup.current === popup && !authWindow.closed) authWindow.location.href = url;
    } catch {
      if (oauthPopup.current === popup) {
        oauthPopup.current = null;
        showError("Couldn’t open GitHub authorization. Try again.");
      }
      authWindow.close();
    }
  }, []);

  if (account) {
    const { Dashboard, data } = account;
    return (
      <Dashboard
        account={data}
        onAuthorizeDelete={() => openGitHub(true)}
        deleteAuthorizationError={deleteAuthorizationError}
        onDisconnect={() => {
          oauthPopup.current?.window.close();
          oauthPopup.current = null;
          accountRequestId.current += 1;
          setDeleteAuthorizationError(null);
          setAccount(null);
        }}
      />
    );
  }

  const connectButton = (
    <button
      onClick={() => openGitHub()}
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
      <h1 className={`${T.h1} text-ink dark:text-white mb-2`}>{HOME_HEADING}</h1>
      <p className={`${T.prose} text-muted max-w-copy mb-8`}>
        Push the files inside a ZIP to a GitHub repository without installing Git. On desktop, you can also upload a project folder.
      </p>
      <div className="w-full flex flex-col [&>button]:w-full lg:w-auto lg:block lg:[&>button]:w-auto">{connectButton}</div>
      {errorMsg && <div className="w-full"><Alert variant="error" className="mt-3">{errorMsg}</Alert></div>}
      <p className="mt-6 flex items-start gap-2 text-sm text-muted max-w-copy">
        <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0 text-emerald-700 dark:text-emerald-400" />
        <span>{SECRET_SCAN_NOTE} <Link to="/faq" className="underline">See which GitHub permissions we request.</Link></span>
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
      ) : accountLoadFailed ? (
        <div className="flex-1 self-center p-6 lg:p-12">
          <h1 className={`${T.h1} text-ink dark:text-white mb-3`}>Couldn’t load your GitHub account</h1>
          <p role="status" className="text-muted mb-6">Try loading your account again to reopen the dashboard.</p>
          <button type="button" onClick={() => loadAccount()} className={`${CTRL} px-5 bg-primary text-on-primary hover:bg-primary-hover`}>
            Retry loading account
          </button>
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
