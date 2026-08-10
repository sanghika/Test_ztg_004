import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockReposGet,
  mockCreateOrUpdateFileContents,
  mockGetRef,
  mockGetCommit,
  mockCreateBlob,
  mockCreateTree,
  mockCreateCommit,
  mockUpdateRef,
} = vi.hoisted(() => ({
  mockReposGet: vi.fn(),
  mockCreateOrUpdateFileContents: vi.fn(),
  mockGetRef: vi.fn(),
  mockGetCommit: vi.fn(),
  mockCreateBlob: vi.fn(),
  mockCreateTree: vi.fn(),
  mockCreateCommit: vi.fn(),
  mockUpdateRef: vi.fn(),
}));

vi.mock("octokit", () => ({
  Octokit: vi.fn().mockImplementation(function (this: any) {
    this.rest = {
      repos: {
        get: mockReposGet,
        createOrUpdateFileContents: mockCreateOrUpdateFileContents,
      },
      git: {
        getRef: mockGetRef,
        getCommit: mockGetCommit,
        createBlob: mockCreateBlob,
        createTree: mockCreateTree,
        createCommit: mockCreateCommit,
        updateRef: mockUpdateRef,
      },
    };
  }),
}));

const { uploadToGitHub } = await import("./githubService");

beforeEach(() => {
  vi.clearAllMocks();
});

const makeFiles = () => [{ path: "index.js", content: Buffer.from("console.log(1)").toString("base64") }];

describe("uploadToGitHub — empty repository (GitHub Git Data API 409 case)", () => {
  it("initializes via the Contents API before touching the Git Data API, then finalizes with updateRef", async () => {
    mockReposGet.mockResolvedValue({ data: { default_branch: "main" } });
    // Mirrors GitHub's real, documented behavior: the Git Data API 409s on a
    // truly empty repo (see https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-your-git-database).
    mockGetRef.mockRejectedValueOnce(Object.assign(new Error("Git Repository is empty."), { status: 409 }));
    mockCreateOrUpdateFileContents.mockResolvedValue({ data: { commit: { sha: "init-commit-sha" } } });
    mockGetCommit.mockResolvedValue({ data: { tree: { sha: "init-tree-sha" } } });
    mockCreateBlob.mockResolvedValue({ data: { sha: "blob-sha-1" } });
    mockCreateTree.mockResolvedValue({ data: { sha: "new-tree-sha" } });
    mockCreateCommit.mockResolvedValue({ data: { sha: "final-commit-sha" } });
    mockUpdateRef.mockResolvedValue({ data: {} });

    await uploadToGitHub("fake-token", "me", "empty-repo", makeFiles(), "Upload files", vi.fn());

    // Must initialize the empty repo via the Contents API first.
    expect(mockCreateOrUpdateFileContents).toHaveBeenCalledTimes(1);
    expect(mockCreateOrUpdateFileContents).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "me", repo: "empty-repo", path: "README.md", branch: "main" })
    );

    // Blob creation (Git Data API) must happen only after that init call —
    // calling it first is exactly the bug being regression-tested here.
    const initOrder = mockCreateOrUpdateFileContents.mock.invocationCallOrder[0];
    const blobOrder = mockCreateBlob.mock.invocationCallOrder[0];
    expect(initOrder).toBeLessThan(blobOrder);

    // Finalizes against the branch the init step created — updateRef, not createRef.
    expect(mockUpdateRef).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "me", repo: "empty-repo", ref: "heads/main", sha: "final-commit-sha" })
    );
  });

  it("does not attempt Contents-API init for a repo that already has commits", async () => {
    mockReposGet.mockResolvedValue({ data: { default_branch: "main" } });
    mockGetRef.mockResolvedValue({ data: { object: { sha: "existing-commit-sha" } } });
    mockGetCommit.mockResolvedValue({ data: { tree: { sha: "existing-tree-sha" } } });
    mockCreateBlob.mockResolvedValue({ data: { sha: "blob-sha-1" } });
    mockCreateTree.mockResolvedValue({ data: { sha: "new-tree-sha" } });
    mockCreateCommit.mockResolvedValue({ data: { sha: "final-commit-sha" } });
    mockUpdateRef.mockResolvedValue({ data: {} });

    await uploadToGitHub("fake-token", "me", "normal-repo", makeFiles(), "Upload files", vi.fn());

    expect(mockCreateOrUpdateFileContents).not.toHaveBeenCalled();
    expect(mockUpdateRef).toHaveBeenCalledWith(
      expect.objectContaining({ sha: "final-commit-sha", ref: "heads/main" })
    );
  });

  it("surfaces a clear error if Contents-API init unexpectedly returns no commit sha", async () => {
    mockReposGet.mockResolvedValue({ data: { default_branch: "main" } });
    mockGetRef.mockRejectedValueOnce(Object.assign(new Error("Git Repository is empty."), { status: 409 }));
    mockCreateOrUpdateFileContents.mockResolvedValue({ data: { commit: {} } }); // no sha

    await expect(
      uploadToGitHub("fake-token", "me", "empty-repo", makeFiles(), "Upload files", vi.fn())
    ).rejects.toThrow(/no commit SHA/i);
  });
});
