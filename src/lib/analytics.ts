// Google Analytics (GA4), loaded only when it can actually collect something.
//
//  - Off unless VITE_GA_MEASUREMENT_ID is set, at build time (Vite inlines it),
//    to a real GA4 ID, and only in a production build. With no ID there is no
//    third-party script, no request and no cookie; trackEvent and trackPageView
//    do nothing.
//  - gtag.js is added after the page's `load` event, when the browser is idle,
//    so it never competes with first paint. Calls made before it arrives are
//    queued in window.dataLayer and processed when it does, so nothing is lost.
//  - Page views are sent by trackPageView, once per screen. The config call
//    sets send_page_view: false; leaving it on would count every first page
//    twice (once from config, once from trackPageView).

import type { Metric } from "web-vitals";
import { findPublicPage } from "../routes";

type ErrorKind = "authentication" | "rate_limit" | "client" | "server" | "other";

export function analyticsErrorKind(error: unknown): ErrorKind {
  const status = error instanceof Error && "status" in error ? error.status : undefined;
  if (status === 401 || status === 403) return "authentication";
  if (status === 429) return "rate_limit";
  if (typeof status === "number" && status >= 500 && status < 600) return "server";
  if (typeof status === "number" && status >= 400 && status < 500) return "client";
  return "other";
}

type AnalyticsEvents = {
  connect_github_initiated: undefined;
  repo_created: { is_private: boolean };
  zip_uploaded: { size_bytes: number };
  folder_uploaded: { file_count: number };
  secrets_sanitized: { skipped_count: number; redacted_count: number };
  push_successful: { files_count: number };
  push_failed: { error_kind: ErrorKind };
  repo_files_deleted: { count: number };
  repo_files_delete_failed: { error_kind: ErrorKind };
  repo_deleted: undefined;
  repo_delete_failed: { error_kind: ErrorKind };
  web_vital: {
    entry_route: string;
    entry_session: "returning" | "signed_out";
    viewport_class: "small" | "medium" | "large";
    metric_name: Metric["name"];
    metric_id: string;
    metric_value: number;
    metric_rating: Metric["rating"];
  };
};

const eventFields: { [Name in keyof AnalyticsEvents]: (keyof AnalyticsEvents[Name])[] } = {
  connect_github_initiated: [],
  repo_created: ["is_private"],
  zip_uploaded: ["size_bytes"],
  folder_uploaded: ["file_count"],
  secrets_sanitized: ["skipped_count", "redacted_count"],
  push_successful: ["files_count"],
  push_failed: ["error_kind"],
  repo_files_deleted: ["count"],
  repo_files_delete_failed: ["error_kind"],
  repo_deleted: [],
  repo_delete_failed: ["error_kind"],
  web_vital: ["entry_route", "entry_session", "viewport_class", "metric_name", "metric_id", "metric_value", "metric_rating"],
};

type EventArgs = {
  [Name in keyof AnalyticsEvents]: AnalyticsEvents[Name] extends undefined
    ? [name: Name]
    : [name: Name, params: AnalyticsEvents[Name]];
}[keyof AnalyticsEvents];

function pageFields(location: AnalyticsWindow["location"], pathname = location.pathname) {
  const page = findPublicPage(pathname);
  const path = page?.path ?? "/other";
  return {
    page_path: path,
    page_location: location.origin + path,
    page_title: page?.title ?? "Page not found | ZiptoGit",
    page_referrer: "",
  };
}

// GA4 IDs look like G-ABC123XYZ0. Anything else, such as the old placeholder
// G-TRACKING_ID, is treated as "not configured".
const MEASUREMENT_ID_PATTERN = /^G-[A-Z0-9]+$/;

export interface AnalyticsWindow {
  dataLayer?: unknown[];
  gtag?: (...args: unknown[]) => void;
  location: { pathname: string; origin: string };
  addEventListener(type: "load", listener: () => void, options?: { once?: boolean }): void;
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  setTimeout(callback: () => void, ms: number): number;
}

export interface AnalyticsDocument {
  readyState: string;
  createElement(tag: "script"): { async: boolean; src: string };
  head: { appendChild(node: unknown): unknown };
}

export interface Analytics {
  isEnabled: boolean;
  trackEvent(...args: EventArgs): void;
  trackPageView(): void;
}

export const createAnalytics = (
  measurementId: string | undefined,
  browser: { win: AnalyticsWindow; doc: AnalyticsDocument } | null
): Analytics => {
  const id = measurementId && MEASUREMENT_ID_PATTERN.test(measurementId) ? measurementId : null;
  const enabled = id !== null && browser !== null;
  let started = false;

  const start = (): AnalyticsWindow | null => {
    if (!enabled || !browser) return null;
    const { win, doc } = browser;
    if (started) return win;
    started = true;

    const layer: unknown[] = (win.dataLayer = win.dataLayer || []);
    // gtag.js reads `arguments` objects from the data layer; pushing an array
    // of the arguments instead would be ignored.
    win.gtag = function () {
      layer.push(arguments);
    };
    win.gtag("js", new Date());
    win.gtag("config", id, { send_page_view: false, ...pageFields(win.location) });

    const addScript = () => {
      const script = doc.createElement("script");
      script.async = true;
      script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id!)}`;
      doc.head.appendChild(script);
    };
    const whenIdle = () => {
      if (win.requestIdleCallback) win.requestIdleCallback(addScript, { timeout: 5000 });
      else win.setTimeout(addScript, 2000);
    };
    if (doc.readyState === "complete") whenIdle();
    else win.addEventListener("load", whenIdle, { once: true });
    return win;
  };

  return {
    isEnabled: enabled,
    trackEvent(...[name, params]) {
      const win = start();
      if (!win?.gtag) return;
      const fields: readonly string[] = eventFields[name];
      const safeParams = Object.fromEntries(Object.entries(params ?? {}).filter(([key]) => fields.includes(key)));
      const context = pageFields(win.location, name === "web_vital" ? params.entry_route : undefined);
      if (name === "web_vital") safeParams.entry_route = context.page_path;
      win.gtag("event", name, { ...safeParams, ...context });
    },
    trackPageView() {
      const win = start();
      if (!win?.gtag) return;
      const fields = pageFields(win.location);
      win.gtag("set", fields);
      win.gtag("event", "page_view", fields);
    },
  };
};

// Pages are prerendered in Node, where there is no window: everything below is
// then a no-op.
const inBrowser = typeof window !== "undefined" && typeof document !== "undefined";

const analytics = createAnalytics(
  import.meta.env.PROD ? import.meta.env.VITE_GA_MEASUREMENT_ID : undefined,
  inBrowser ? { win: window as unknown as AnalyticsWindow, doc: document as unknown as AnalyticsDocument } : null
);

export const trackEvent = analytics.trackEvent;
export const trackPageView = analytics.trackPageView;
export const analyticsEnabled = analytics.isEnabled;
