import path from "path";

// True when the last segment of a URL path has a file extension (/assets/x.js,
// /favicon.ico, /.well-known/security.txt). The SPA fallback in server.ts must
// not answer these with index.html: a missing /assets/*.js chunk (an old tab
// after a deploy) would arrive as HTML with status 200, which the browser then
// fails to run as a module, with a confusing "Unexpected token '<'" instead of
// a clean 404. Route paths of the app (/, /faq, /auth/callback) have no
// extension. Only the last segment counts, so /v1.2/page is still a route.
export function hasFileExtension(urlPath: string): boolean {
  return path.posix.extname(urlPath) !== "";
}
