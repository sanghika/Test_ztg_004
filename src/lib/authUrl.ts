// The GitHub sign-in URL comes from GET /api/auth/url. The server builds it with a
// fresh OAuth `state` and stores that state in a signed, HttpOnly cookie, which
// /auth/callback checks later. Fetching it only after the click leaves the popup
// blank for one round trip, so it is fetched a moment earlier: on hover, focus or
// touch of the Connect button. Each attempt has its own cookie, so another
// tab can prefetch or connect independently. The local cache holds each URL
// for at most 30 seconds and hands it out at most once.

export const AUTH_URL_TTL_MS = 30_000;

type Entry = { promise: Promise<string>; at: number };
let entry: Entry | null = null;

async function requestAuthUrl(path = "/api/auth/url"): Promise<string> {
  const response = await fetch(path);
  if (!response.ok) throw new Error("Failed to get auth URL");
  const body = await response.json();
  if (typeof body?.url !== "string" || !body.url) throw new Error("Failed to get auth URL");
  return body.url;
}

const isFresh = (e: Entry | null): e is Entry => e !== null && Date.now() - e.at < AUTH_URL_TTL_MS;

/** Starts fetching the URL, unless a fresh one is already on its way. Never throws. */
export function prefetchAuthUrl(): void {
  if (isFresh(entry)) return;
  const mine: Entry = { promise: requestAuthUrl(), at: Date.now() };
  entry = mine;
  // A failed prefetch is forgotten, so the click fetches again by itself.
  mine.promise.catch(() => {
    if (entry === mine) entry = null;
  });
}

/** The URL for this click: the prefetched one if there is a fresh one, else a new request. */
export async function takeAuthUrl(): Promise<string> {
  const ready = isFresh(entry) ? entry : null;
  entry = null; // one use only: the state in it is spent once the popup opens it
  if (ready) {
    try {
      return await ready.promise;
    } catch {
      // fall through to a fresh request
    }
  }
  return requestAuthUrl();
}

/** Start a separate authorization for the repository deletion feature. */
export function takeDeleteAuthorizationUrl(): Promise<string> {
  return requestAuthUrl("/api/auth/url?intent=delete-repo");
}

/** For tests. */
export function resetAuthUrlCache(): void {
  entry = null;
}
