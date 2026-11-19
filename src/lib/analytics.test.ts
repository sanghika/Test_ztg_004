import { describe, it, expect } from "vitest";
import { analyticsErrorKind, createAnalytics, trackEvent, trackPageView, type AnalyticsDocument, type AnalyticsWindow } from "./analytics";

const makeBrowser = ({ readyState = "loading", idle = true } = {}) => {
  const loadListeners: (() => void)[] = [];
  const idleQueue: (() => void)[] = [];
  const timeouts: { cb: () => void; ms: number }[] = [];
  const scripts: { async: boolean; src: string }[] = [];
  const win: AnalyticsWindow = {
    location: new URL("https://ziptogit.in/faq?from=private#project"),
    addEventListener: (_type, cb) => {
      loadListeners.push(cb);
    },
    requestIdleCallback: idle
      ? (cb) => {
          idleQueue.push(cb);
          return 1;
        }
      : undefined,
    setTimeout: (cb, ms) => {
      timeouts.push({ cb, ms });
      return 1;
    },
  };
  const doc: AnalyticsDocument = {
    readyState,
    createElement: () => ({ async: false, src: "" }),
    head: { appendChild: (node) => scripts.push(node as { async: boolean; src: string }) },
  };
  return {
    win,
    doc,
    scripts,
    timeouts,
    fireLoad: () => loadListeners.splice(0).forEach((cb) => cb()),
    runIdle: () => idleQueue.splice(0).forEach((cb) => cb()),
  };
};

// gtag.js reads `arguments` objects from the data layer; turn them back into arrays to compare.
const queued = (win: AnalyticsWindow) => (win.dataLayer ?? []).map((entry) => Array.from(entry as ArrayLike<unknown>));

const REAL_ID = "G-ABC123XYZ0";

describe("analytics is off unless there is a real measurement ID", () => {
  it.each([
    ["no ID", undefined],
    ["an empty ID", ""],
    ["the old placeholder", "G-TRACKING_ID"],
    ["a UA-style ID", "UA-12345-1"],
    ["a lowercase ID", "g-abc123"],
  ])("does nothing with %s", (_label, id) => {
    const b = makeBrowser({ readyState: "complete" });
    const analytics = createAnalytics(id, { win: b.win, doc: b.doc });

    analytics.trackPageView();
    analytics.trackEvent("zip_uploaded", { size_bytes: 1 });
    b.runIdle();

    expect(analytics.isEnabled).toBe(false);
    expect(b.win.dataLayer).toBeUndefined();
    expect(b.win.gtag).toBeUndefined();
    expect(b.scripts).toEqual([]);
  });

  it("does nothing outside a browser (prerender)", () => {
    const analytics = createAnalytics(REAL_ID, null);
    expect(() => {
      analytics.trackPageView();
      analytics.trackEvent("repo_deleted");
    }).not.toThrow();
    expect(analytics.isEnabled).toBe(false);
  });

  it("is disabled in this test build, because there is no ID and no window", () => {
    expect(() => {
      trackPageView();
      trackEvent("zip_uploaded", { size_bytes: 1 });
    }).not.toThrow();
  });
});

const faqContext = {
  page_path: "/faq",
  page_location: "https://ziptogit.in/faq",
  page_title: "GitHub ZIP uploads: limits, permissions and pricing | ZiptoGit",
  page_referrer: "",
};

describe("analytics with a real ID", () => {
  it("counts the first page view once: config does not send one, trackPageView does", () => {
    const b = makeBrowser();
    const analytics = createAnalytics(REAL_ID, { win: b.win, doc: b.doc });

    analytics.trackPageView();

    const entries = queued(b.win);
    const configs = entries.filter((e) => e[0] === "config");
    const pageViews = entries.filter((e) => e[0] === "event" && e[1] === "page_view");
    expect(configs).toEqual([["config", REAL_ID, { send_page_view: false, ...faqContext }]]);
    expect(pageViews).toEqual([
      ["event", "page_view", faqContext],
    ]);
  });

  it("calls config only once, however many page views and events follow", () => {
    const b = makeBrowser();
    const analytics = createAnalytics(REAL_ID, { win: b.win, doc: b.doc });

    analytics.trackPageView();
    analytics.trackEvent("zip_uploaded", { size_bytes: 10 });
    analytics.trackPageView();

    const names = queued(b.win).map((e) => e[0] === "event" ? `event:${e[1]}` : e[0]);
    expect(names).toEqual(["js", "config", "set", "event:page_view", "event:zip_uploaded", "set", "event:page_view"]);
  });

  it("groups unknown URLs and never includes their path, query, or fragment", () => {
    const b = makeBrowser();
    b.win.location = new URL("https://ziptogit.in/private-project?token=local#filename");
    const analytics = createAnalytics(REAL_ID, { win: b.win, doc: b.doc });
    analytics.trackPageView();
    analytics.trackEvent("repo_deleted");

    const entries = queued(b.win);
    expect(JSON.stringify(entries)).not.toMatch(/private-project|token=local|filename/);
    expect(entries.at(-1)).toEqual(["event", "repo_deleted", {
      page_path: "/other",
      page_location: "https://ziptogit.in/other",
      page_title: "Page not found | ZiptoGit",
      page_referrer: "",
    }]);
  });

  it("filters extra upload details and sends an error category instead of an API message", () => {
    const b = makeBrowser();
    const analytics = createAnalytics(REAL_ID, { win: b.win, doc: b.doc });
    const upload = { size_bytes: 20, file_name: "private-project.zip" };
    analytics.trackEvent("zip_uploaded", upload);
    const error = Object.assign(new Error("Could not push private-project.zip"), { status: 503 });
    const failure = { error_kind: analyticsErrorKind(error), error: error.message };
    analytics.trackEvent("push_failed", failure);
    expect(queued(b.win).slice(-2)).toEqual([
      ["event", "zip_uploaded", { size_bytes: 20, ...faqContext }],
      ["event", "push_failed", { error_kind: "server", ...faqContext }],
    ]);
  });

  it("queues events made before gtag.js has arrived", () => {
    const b = makeBrowser();
    createAnalytics(REAL_ID, { win: b.win, doc: b.doc }).trackEvent("push_successful", { files_count: 3 });

    expect(b.scripts).toHaveLength(0);
    expect(queued(b.win).at(-1)).toEqual(["event", "push_successful", { files_count: 3, ...faqContext }]);
  });

  it("adds gtag.js only after the load event and an idle moment, and only once", () => {
    const b = makeBrowser({ readyState: "loading" });
    const analytics = createAnalytics(REAL_ID, { win: b.win, doc: b.doc });

    analytics.trackPageView();
    expect(b.scripts).toHaveLength(0); // page has not loaded yet

    b.fireLoad();
    expect(b.scripts).toHaveLength(0); // loaded, but not idle yet

    b.runIdle();
    expect(b.scripts).toHaveLength(1);
    expect(b.scripts[0].async).toBe(true);
    expect(b.scripts[0].src).toBe(`https://www.googletagmanager.com/gtag/js?id=${REAL_ID}`);

    analytics.trackPageView();
    b.fireLoad();
    b.runIdle();
    expect(b.scripts).toHaveLength(1);
  });

  it("waits for idle, without waiting for a load that already happened", () => {
    const b = makeBrowser({ readyState: "complete" });
    createAnalytics(REAL_ID, { win: b.win, doc: b.doc }).trackPageView();

    expect(b.scripts).toHaveLength(0);
    b.runIdle();
    expect(b.scripts).toHaveLength(1);
  });

  it("falls back to a timeout where requestIdleCallback does not exist", () => {
    const b = makeBrowser({ readyState: "complete", idle: false });
    createAnalytics(REAL_ID, { win: b.win, doc: b.doc }).trackPageView();

    expect(b.scripts).toHaveLength(0);
    expect(b.timeouts).toHaveLength(1);
    b.timeouts[0].cb();
    expect(b.scripts).toHaveLength(1);
  });
});
