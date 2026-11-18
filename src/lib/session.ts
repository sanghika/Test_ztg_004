// The has_session flag cookie (see SESSION_FLAG_COOKIE in server.ts).
//
// The real session is an HttpOnly cookie that JavaScript cannot see, so the
// page used to have no way to know "is this visitor probably signed in?"
// without a round trip to the server, and showed a spinner until it came back. The
// server now also sets a readable flag cookie next to it. It is a hint for
// choosing what to show first, never proof of anything: the server still
// checks the real session on every API call.

/** True when a `document.cookie`-style string contains has_session=1. */
export function hasSessionFlag(cookieString: string): boolean {
  return /(?:^|;\s*)has_session=1(?:;|$)/.test(cookieString);
}

export function readSessionFlag(): boolean {
  return typeof document !== "undefined" && hasSessionFlag(document.cookie);
}

/** Drop the flag when the server says there is no session behind it. */
export function clearSessionFlag(): void {
  if (typeof document === "undefined") return;
  document.cookie = "has_session=; Max-Age=0; Path=/; SameSite=Lax";
}

// The class index.html puts on <html> when it saw the flag at load and started
// GET /api/bootstrap. It records the page's verdict as of load time. Re-reading the
// cookie later is not equivalent: that very request can answer 401, and the
// server clears the flag with it, all before the JS bundle has booted.
export const SESSION_PENDING_CLASS = "session-pending";

export function sessionPending(): boolean {
  return typeof document !== "undefined" && document.documentElement.classList.contains(SESSION_PENDING_CLASS);
}

export function endSessionPending(): void {
  if (typeof document !== "undefined") document.documentElement.classList.remove(SESSION_PENDING_CLASS);
}
