import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockReposGet, mockGetRef, mockGetTree, mockGetCommit, mockCreateTree, mockCreateCommit, mockUpdateRef } = vi.hoisted(() => ({
  mockReposGet: vi.fn(),
  mockGetRef: vi.fn(),
  mockGetTree: vi.fn(),
  mockGetCommit: vi.fn(),
  mockCreateTree: vi.fn(),
  mockCreateCommit: vi.fn(),
  mockUpdateRef: vi.fn(),
}));

vi.mock("./octokit", () => ({
  Octokit: vi.fn().mockImplementation(function (this: any) {
    this.rest = {
      repos: { get: mockReposGet },
      git: {
        getRef: mockGetRef,
        getTree: mockGetTree,
        getCommit: mockGetCommit,
        createTree: mockCreateTree,
        createCommit: mockCreateCommit,
        updateRef: mockUpdateRef,
      },
    };
  }),
}));

const { fetchRepoTree, deleteRepoPaths } = await import("./githubService");

beforeEach(() => {
  // Reset each API mock but keep the Octokit constructor mock above intact.
  for (const m of [mockReposGet, mockGetRef, mockGetTree, mockGetCommit, mockCreateTree, mockCreateCommit, mockUpdateRef]) {
    m.mockReset();
  }
});

const blob = (path: string, sha = `sha-${path}`) => ({ path, type: "blob", sha, size: 1, mode: "100644" });
const tree = (path: string, sha = `sha-${path}`) => ({ path, type: "tree", sha, mode: "040000" });
const apiError = (status: number, message = "x") => Object.assign(new Error(message), { status });

describe("fetchRepoTree", () => {
  it("makes ONE request when the default branch is known", async () => {
    mockGetTree.mockResolvedValue({ data: { tree: [blob("a.txt")], truncated: false } });

    const result = await fetchRepoTree("t", "o", "r", "trunk");

    expect(mockReposGet).not.toHaveBeenCalled();
    expect(mockGetRef).not.toHaveBeenCalled();
    expect(mockGetTree).toHaveBeenCalledTimes(1);
    expect(mockGetTree).toHaveBeenCalledWith({ owner: "o", repo: "r", tree_sha: "trunk", recursive: "true" });
    expect(result).toEqual({
      tree: [{ path: "a.txt", type: "blob", sha: "sha-a.txt", size: 1 }],
      defaultBranch: "trunk",
      truncated: false,
    });
  });

  it("makes two requests, not three, when the branch is not known", async () => {
    mockReposGet.mockResolvedValue({ data: { default_branch: "develop" } });
    mockGetTree.mockResolvedValue({ data: { tree: [], truncated: false } });

    const result = await fetchRepoTree("t", "o", "r");

    expect(mockReposGet).toHaveBeenCalledTimes(1);
    expect(mockGetRef).not.toHaveBeenCalled();
    expect(mockGetTree).toHaveBeenCalledWith({ owner: "o", repo: "r", tree_sha: "develop", recursive: "true" });
    expect(result.defaultBranch).toBe("develop");
  });

  it("falls back to asking GitHub when the passed branch is stale", async () => {
    mockGetTree
      .mockRejectedValueOnce(apiError(404, "Not Found")) // "old-name" no longer exists
      .mockResolvedValueOnce({ data: { tree: [blob("a.txt")], truncated: false } });
    mockReposGet.mockResolvedValue({ data: { default_branch: "main" } });

    const result = await fetchRepoTree("t", "o", "r", "old-name");

    expect(result.defaultBranch).toBe("main");
    expect(result.tree).toHaveLength(1);
    expect(mockGetTree).toHaveBeenLastCalledWith({ owner: "o", repo: "r", tree_sha: "main", recursive: "true" });
  });

  it("returns an empty list for a repository with no commits (409)", async () => {
    mockGetTree.mockRejectedValue(apiError(409, "Git Repository is empty."));

    expect(await fetchRepoTree("t", "o", "r", "main")).toEqual({ tree: [], defaultBranch: "main", truncated: false });
    // A 409 is the answer, so it must not trigger the fallback.
    expect(mockReposGet).not.toHaveBeenCalled();
  });

  it("reports truncated when GitHub cut the list off", async () => {
    mockGetTree.mockResolvedValue({ data: { tree: [blob("a.txt")], truncated: true } });
    expect((await fetchRepoTree("t", "o", "r", "main")).truncated).toBe(true);
  });

  it("no longer hides real errors as an empty repository", async () => {
    mockReposGet.mockRejectedValue(apiError(404, "Not Found"));
    await expect(fetchRepoTree("t", "o", "r")).rejects.toThrow("Not Found");

    mockReposGet.mockResolvedValue({ data: { default_branch: "main" } });
    mockGetTree.mockRejectedValue(apiError(403, "rate limited"));
    await expect(fetchRepoTree("t", "o", "r")).rejects.toThrow("rate limited");
  });

  it("keeps only files and folders (drops submodules)", async () => {
    mockGetTree.mockResolvedValue({
      data: { tree: [blob("a"), { path: "sub", type: "commit", sha: "c" }, tree("d")], truncated: false },
    });
    const result = await fetchRepoTree("t", "o", "r", "main");
    expect(result.tree.map((e) => e.path)).toEqual(["a", "d"]);
  });
});

describe("deleteRepoPaths with a truncated tree", () => {
  const arrangeRepo = () => {
    mockReposGet.mockResolvedValue({ data: { default_branch: "main" } });
    mockGetRef.mockResolvedValue({ data: { object: { sha: "head-commit" } } });
    mockGetCommit.mockResolvedValue({ data: { tree: { sha: "base-tree" } } });
    mockCreateTree.mockResolvedValue({ data: { sha: "new-tree" } });
    mockCreateCommit.mockResolvedValue({ data: { sha: "new-commit" } });
    mockUpdateRef.mockResolvedValue({});
  };

  it("reports a failed branch lookup instead of treating the repository as empty", async () => {
    arrangeRepo();
    const error = apiError(503, "GitHub unavailable");
    mockGetRef.mockRejectedValueOnce(error);

    await expect(deleteRepoPaths("t", "o", "r", ["x"], "msg")).rejects.toBe(error);
    expect(mockCreateTree).not.toHaveBeenCalled();
  });

  it("walks the tree folder by folder so files past the cut-off are still deleted", async () => {
    arrangeRepo();
    // The recursive request is cut off and only knows about root.txt.
    // Walking: root → { src/, root.txt }, src → { deep/, a.ts }, deep → { gone.ts }
    mockGetTree.mockImplementation(async ({ tree_sha, recursive }: any) => {
      if (recursive) return { data: { tree: [blob("root.txt")], truncated: true } };
      if (tree_sha === "head-commit") return { data: { tree: [tree("src", "src-sha"), blob("root.txt")], truncated: false } };
      if (tree_sha === "src-sha") return { data: { tree: [tree("deep", "deep-sha"), blob("a.ts")], truncated: false } };
      if (tree_sha === "deep-sha") return { data: { tree: [blob("gone.ts")], truncated: false } };
      throw new Error(`unexpected tree ${tree_sha}`);
    });

    await deleteRepoPaths("t", "o", "r", ["src/deep"], "msg");

    const { tree: items } = mockCreateTree.mock.calls[0][0];
    expect(items.map((i: any) => i.path)).toEqual(["src/deep/gone.ts"]);
    expect(items[0].sha).toBeNull();
  });

  it("does not walk when the tree is complete", async () => {
    arrangeRepo();
    mockGetTree.mockResolvedValue({ data: { tree: [blob("a.txt"), blob("b.txt")], truncated: false } });

    await deleteRepoPaths("t", "o", "r", ["a.txt"], "msg");

    expect(mockGetTree).toHaveBeenCalledTimes(1);
    expect(mockCreateTree.mock.calls[0][0].tree.map((i: any) => i.path)).toEqual(["a.txt"]);
  });

  it("refuses rather than delete from a partial list when one folder is itself too large", async () => {
    arrangeRepo();
    mockGetTree.mockImplementation(async ({ recursive }: any) =>
      recursive
        ? { data: { tree: [], truncated: true } }
        : { data: { tree: [blob("x")], truncated: true } }
    );

    await expect(deleteRepoPaths("t", "o", "r", ["x"], "msg")).rejects.toThrow(/too large to list completely/);
    expect(mockCreateTree).not.toHaveBeenCalled();
  });
});
