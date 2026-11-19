import { createHash } from "node:crypto";

// HTML parsers normalize line endings before applying a script hash.
export const inlineScriptSource = (source: string): string =>
  "'sha256-" + createHash("sha256").update(source.replace(/\r\n?/g, "\n")).digest("base64") + "'";

export const pageContentSecurityPolicy = (html: string): string => {
  // The production HTML uses the same two inline startup scripts on all routes.
  // The generated JSON-LD is data and requires no executable script permission.
  const startupHashes = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g), ([, script]) => inlineScriptSource(script));
  const googleTag = " https://*.googletagmanager.com";
  const googleAnalytics = " https://*.google-analytics.com https://*.analytics.google.com";
  return [
    "default-src 'none'",
    ["script-src 'self'", ...startupHashes].join(" ") + googleTag,
    // React uses inline styles for file-tree layout and upload progress.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://avatars.githubusercontent.com" + googleTag + googleAnalytics,
    "connect-src 'self' https://avatars.githubusercontent.com" + googleTag + googleAnalytics,
    "font-src 'self'",
    "worker-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
};
