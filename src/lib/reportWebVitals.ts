import type { Metric } from "web-vitals";
import { findPublicPage } from "../routes";
import { analyticsEnabled, trackEvent } from "./analytics";
import { readSessionFlag, sessionPending } from "./session";

function entryContext() {
  const route = findPublicPage(location.pathname)?.path ?? "/other";
  return {
    entry_route: route,
    entry_session: readSessionFlag() || sessionPending() ? "returning" : "signed_out",
    viewport_class: innerWidth < 640 ? "small" : innerWidth < 1024 ? "medium" : "large",
  } as const;
}

export async function reportWebVitals() {
  if (!analyticsEnabled || Math.random() >= 0.1) return;

  // These metrics describe the document visit, including interactions after
  // client-side navigation. Label them with the route where the visit began.
  let context = entryContext();
  const { onCLS, onINP, onLCP } = await import("web-vitals");
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) context = entryContext();
  });
  const report = (metric: Metric) => {
    trackEvent("web_vital", {
      ...context,
      metric_name: metric.name,
      metric_id: metric.id,
      metric_value: metric.value,
      metric_rating: metric.rating,
    });
  };
  onCLS(report);
  onINP(report);
  onLCP(report);
}
