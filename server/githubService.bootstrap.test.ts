import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockListRepos, mockGetAuthenticated } = vi.hoisted(() => ({
  mockListRepos: vi.fn(),
  mockGetAuthenticated: vi.fn(),
}));

vi.mock("./octokit", () => ({
  Octokit: vi.fn().mockImplementation(function (this: any) {
    this.rest = {
      repos: { listForAuthenticatedUser: mockListRepos },
      users: { getAuthenticated: mockGetAuthenticated },
    };
  }),
}));

import { fetchRepositoryPage, fetchUser, hasNextPage, toRepoSummary, toUserSummary } from "./githubService";

// Shaped like GitHub's real objects: the four fields the app uses, buried
// among the dozens it does not.
const bigRepo = (id: number) => ({
  id,
  name: `repo-${id}`,
  full_name: `octocat/repo-${id}`,
  default_branch: "main",
  private: false,
  html_url: `https://github.com/octocat/repo-${id}`,
  description: "x".repeat(200),
  owner: { login: "octocat", id: 1, avatar_url: "https://a/1", url: "https://api.github.com/users/octocat", followers_url: "…" },
  permissions: { admin: true, push: true, pull: true },
  license: { key: "mit", name: "MIT License", spdx_id: "MIT", url: "…" },
  forks_url: "https://api.github.com/repos/octocat/repo/forks",
  git_url: "git://…",
  topics: ["a", "b"],
});

describe("toRepoSummary / toUserSummary", () => {
  it("keep only the fields the client uses", () => {
    expect(toRepoSummary(bigRepo(5))).toEqual({
      id: 5,
      name: "repo-5",
      full_name: "octocat/repo-5",
      default_branch: "main",
    });
    expect(toUserSummary({ login: "octocat", avatar_url: "https://a/1", email: "private@x.y", plan: { name: "pro" } })).toEqual({
      login: "octocat",
      avatar_url: "https://a/1",
    });
  });

  it("still shrink the payload several times over", () => {
    const full = JSON.stringify(Array.from({ length: 100 }, (_, i) => bigRepo(i)));
    const trimmed = JSON.stringify(Array.from({ length: 100 }, (_, i) => toRepoSummary(bigRepo(i))));
    // default_branch (about 25 bytes a repository) is the one field added for
    // the file-tree request; it saves two GitHub round trips there. Real
    // repository objects are far bigger than this fixture, so the margin in
    // practice is wider than the one asserted here.
    expect(trimmed.length * 8).toBeLessThan(full.length);
  });
});

describe("hasNextPage", () => {
  it("is true only when the Link header has a rel=next", () => {
    expect(hasNextPage('<https://api.github.com/user/repos?page=2>; rel="next", <https://api.github.com/user/repos?page=5>; rel="last"')).toBe(true);
    expect(hasNextPage('<https://api.github.com/user/repos?page=1>; rel="prev", <https://api.github.com/user/repos?page=1>; rel="first"')).toBe(false);
    expect(hasNextPage(undefined)).toBe(false);
    expect(hasNextPage("")).toBe(false);
  });
});

describe("fetchRepositoryPage", () => {
  beforeEach(() => mockListRepos.mockReset());

  it("asks GitHub for one page, newest-updated first, and returns trimmed repos", async () => {
    mockListRepos.mockResolvedValue({ data: [bigRepo(1), bigRepo(2)], headers: {} });
    const result = await fetchRepositoryPage("token", 3);
    expect(mockListRepos).toHaveBeenCalledWith({ sort: "updated", per_page: 100, page: 3 });
    expect(result.repos).toEqual([
      { id: 1, name: "repo-1", full_name: "octocat/repo-1", default_branch: "main" },
      { id: 2, name: "repo-2", full_name: "octocat/repo-2", default_branch: "main" },
    ]);
  });

  it("reports the next page from the Link header, and null on the last page", async () => {
    mockListRepos.mockResolvedValueOnce({ data: [], headers: { link: '<https://x?page=3>; rel="next"' } });
    expect((await fetchRepositoryPage("token", 2)).nextPage).toBe(3);
    mockListRepos.mockResolvedValueOnce({ data: [], headers: { link: '<https://x?page=1>; rel="prev"' } });
    expect((await fetchRepositoryPage("token", 2)).nextPage).toBeNull();
    mockListRepos.mockResolvedValueOnce({ data: [], headers: {} });
    expect((await fetchRepositoryPage("token")).nextPage).toBeNull();
  });
});

describe("fetchUser", () => {
  it("returns only login and avatar_url", async () => {
    mockGetAuthenticated.mockResolvedValue({ data: { login: "octocat", avatar_url: "https://a/1", id: 1, email: "e@x.y", plan: {} } });
    expect(await fetchUser("token")).toEqual({ login: "octocat", avatar_url: "https://a/1" });
  });
});
