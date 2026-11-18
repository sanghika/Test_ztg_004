// What the dashboard needs after sign-in (the user and the repository list),
// fetched in parallel and cached per session for a short time.
//
// "Per session" means keyed by a hash of the GitHub token, so one visitor's
// data can never be served to another, and the token itself is not kept as a
// map key. Only successful loads are cached. Creating or deleting a repository,
// and logging out, drop the session's entries, so the app's own changes show
// up straight away; changes made on github.com can lag by up to the TTL.
import crypto from "crypto";
import { TtlCache } from "./ttlCache";
import type { RepoPage, UserSummary } from "./githubService";

export const SESSION_CACHE_TTL_MS = 45_000;

type Service = {
  fetchUser: (token: string) => Promise<UserSummary>;
  fetchRepositoryPage: (token: string, page: number) => Promise<RepoPage>;
};

export type Bootstrap = { user: UserSummary; repos: RepoPage["repos"]; nextPage: number | null };

const sessionKey = (token: string) => crypto.createHash("sha256").update(token).digest("hex").slice(0, 32);

export function createSessionData(service: Service, ttlMs = SESSION_CACHE_TTL_MS, maxEntries = 500, now?: () => number) {
  const cache = new TtlCache<any>(ttlMs, maxEntries, now);

  const getUser = (token: string): Promise<UserSummary> =>
    cache.getOrLoad(`${sessionKey(token)}:user`, () => service.fetchUser(token));

  const getRepoPage = (token: string, page: number): Promise<RepoPage> =>
    cache.getOrLoad(`${sessionKey(token)}:repos:${page}`, () => service.fetchRepositoryPage(token, page));

  return {
    getUser,
    getRepoPage,
    // The two GitHub calls are independent, so they run at the same time. The
    // repository list is only its first page; the rest is loaded by the client
    // through GET /api/repos?page=N once the UI is already on screen.
    async bootstrap(token: string): Promise<Bootstrap> {
      const [user, firstPage] = await Promise.all([getUser(token), getRepoPage(token, 1)]);
      return { user, repos: firstPage.repos, nextPage: firstPage.nextPage };
    },
    invalidate(token: string): void {
      cache.invalidatePrefix(`${sessionKey(token)}:`);
    },
  };
}
