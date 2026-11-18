// Adds a freshly loaded page of repositories to the ones already shown.
// Matching by id (not position) matters because the list is loaded page by
// page while it can change: a repository created in the meantime shifts every
// later page by one, so a page can repeat a repo that is already on screen.
export function mergeRepos<T extends { id: number }>(existing: T[], incoming: T[]): T[] {
  const seen = new Set(existing.map((r) => r.id));
  const fresh = incoming.filter((r) => !seen.has(r.id));
  return fresh.length === 0 ? existing : [...existing, ...fresh];
}
