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

// GA4 IDs look like G-ABC123XYZ0. Anything else, such as the old placeholder
// G-TRACKING_ID, is treated as "not configured".
const MEASUREMENT_ID_PATTERN = /^G-[A-Z0-9]+$/;

export interface AnalyticsWindow {
  dataLayer?: unknown[];
  gtag?: (...args: unknown[]) => void;
  location: { pathname: string; href: string };
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
  trackEvent(name: string, params?: Record<string, unknown>): void;
  trackPageView(title?: string): void;
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
      // eslint-disable-next-line prefer-rest-params
      layer.push(arguments);
    };
    win.gtag("js", new Date());
    win.gtag("config", id, { send_page_view: false });

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
    trackEvent(name, params) {
      start()?.gtag?.("event", name, params);
    },
    trackPageView(title) {
      const win = start();
      if (!win?.gtag) return;
      win.gtag("event", "page_view", {
        page_path: win.location.pathname,
        page_location: win.location.href,
        ...(title ? { page_title: title } : {}),
      });
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
