import { useCallback, useSyncExternalStore } from "react";
import { AlertCircle, Check, CheckCircle, ShieldCheck } from "lucide-react";

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
export const T = {
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
export const CARD_EDGE = "bg-surface rounded-card border border-edge elevation-card";

export const CTRL = "h-11 rounded-control";

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

export function Alert({ variant, className = "", children }: { variant: keyof typeof ALERT_VARIANTS; className?: string; children: React.ReactNode }) {
  const { icon: Icon, role, box } = ALERT_VARIANTS[variant];
  return (
    <div role={role} className={`p-3 rounded-control border text-sm flex items-start gap-2 ${box} ${className}`}>
      <Icon aria-hidden="true" className="w-4 h-4 shrink-0 mt-0.5" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function useMediaQuery(query: string) {
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

export type StepStatus = "done" | "current" | "upcoming";

// The ONE numbered-step badge (24px, 14/500), used by the home screen's
// Repository / Files steps and by the "How it works" list. Outlined, never
// filled, so it stays quieter than any button: a done step shows a green check,
// the current step has an ink ring, upcoming steps are muted. A list that is
// only read (How it works) uses "static", which looks like "current".
export function StepBadge({ n, status, className = "" }: { n: number; status: StepStatus | "static"; className?: string }) {
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
