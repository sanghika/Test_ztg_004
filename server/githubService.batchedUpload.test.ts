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

vi.mock("./octokit", () => ({
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

const { createBlobs, commitUpload } = await import("./githubService");

beforeEach(() => {
  vi.clearAllMocks();
});

const b64 = (text: string) => Buffer.from(text).toString("base64");

describe("createBlobs — repository setup", () => {
  const emptyRepoError = () =>
    Object.assign(new Error("Git Repository is empty."), { status: 409, response: { data: { message: "Git Repository is empty." } } });

  // Mirrors GitHub's documented behavior: until the repo has a first commit,
  // every Git Data API call 409s (see https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-your-git-database).
  const arrangeEmptyRepo = () => {
    let initialized = false;
    mockReposGet.mockResolvedValue({ data: { default_branch: "main" } });
    mockGetRef.mockRejectedValue(emptyRepoError());
    mockCreateOrUpdateFileContents.mockImplementation(async () => {
      initialized = true;
      return { data: { commit: { sha: "init-commit-sha" } } };
    });
    mockGetCommit.mockResolvedValue({ data: { tree: { sha: "init-tree-sha" } } });
    mockCreateBlob.mockImplementation(async ({ content }: { content: string }) => {
      if (!initialized) throw emptyRepoError();
      return { data: { sha: `sha-of-${content}` } };
    });
  };

  it("looks nothing up before uploading when the repository already accepts blobs", async () => {
    mockCreateBlob.mockResolvedValue({ data: { sha: "blob-sha" } });

    await createBlobs("fake-token", "me", "normal-repo", [{ path: "a.txt", content: b64("a") }]);

    expect(mockReposGet).not.toHaveBeenCalled();
    expect(mockGetRef).not.toHaveBeenCalled();
    expect(mockGetCommit).not.toHaveBeenCalled();
    expect(mockCreateOrUpdateFileContents).not.toHaveBeenCalled();
  });

  it("initializes an empty repository through the Contents API when GitHub says it is empty, then retries", async () => {
    arrangeEmptyRepo();

    const blobs = await createBlobs("fake-token", "me", "empty-repo", [{ path: "a.txt", content: b64("a") }]);

    expect(mockCreateOrUpdateFileContents).toHaveBeenCalledTimes(1);
    expect(mockCreateOrUpdateFileContents).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "me", repo: "empty-repo", path: "README.md", branch: "main" })
    );
    expect(blobs).toEqual([{ path: "a.txt", sha: `sha-of-${b64("a")}` }]);
  });

  it("initializes only once when several files hit the empty-repo error at the same moment", async () => {
    arrangeEmptyRepo();
    const files = Array.from({ length: 5 }, (_, i) => ({ path: `f${i}.txt`, content: b64(`file ${i}`) }));

    const blobs = await createBlobs("fake-token", "me", "empty-repo", files);

    expect(mockCreateOrUpdateFileContents).toHaveBeenCalledTimes(1);
    expect(blobs.map((b) => b.path)).toEqual(files.map((f) => f.path));
  });

  it("does not initialize anything for other errors", async () => {
    mockCreateBlob.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));

    await expect(createBlobs("fake-token", "me", "missing", [{ path: "a.txt", content: b64("a") }])).rejects.toThrow("Not Found");
    expect(mockCreateOrUpdateFileContents).not.toHaveBeenCalled();
  });

  it("surfaces a clear error if Contents-API init unexpectedly returns no commit sha", async () => {
    mockReposGet.mockResolvedValue({ data: { default_branch: "main" } });
    mockGetRef.mockRejectedValue(emptyRepoError());
    mockCreateBlob.mockRejectedValue(emptyRepoError());
    mockCreateOrUpdateFileContents.mockResolvedValue({ data: { commit: {} } }); // no sha

    await expect(
      createBlobs("fake-token", "me", "empty-repo", [{ path: "a.txt", content: b64("a") }])
    ).rejects.toThrow(/no commit SHA/i);
  });
});

describe("createBlobs", () => {
  it("stores every file as a base64 blob and returns the SHAs in input order", async () => {
    mockCreateBlob.mockImplementation(async ({ content }: { content: string }) => ({
      data: { sha: `sha-of-${Buffer.from(content, "base64").toString()}` },
    }));
    // More files than the internal concurrency of 5, so more than one group runs.
    const files = Array.from({ length: 7 }, (_, i) => ({ path: `f${i}.txt`, content: b64(`file ${i}`) }));

    const blobs = await createBlobs("fake-token", "me", "repo", files);

    expect(blobs).toEqual(files.map((f, i) => ({ path: f.path, sha: `sha-of-file ${i}` })));
    expect(mockCreateBlob).toHaveBeenCalledTimes(7);
    expect(mockCreateBlob).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "me", repo: "repo", encoding: "base64", content: files[0].content })
    );
    // Blobs only: no tree, no commit, no branch update until commitUpload.
    expect(mockCreateTree).not.toHaveBeenCalled();
    expect(mockCreateCommit).not.toHaveBeenCalled();
    expect(mockUpdateRef).not.toHaveBeenCalled();
  });

  it("keeps up to 5 blobs in flight and does not wait for a slow file before starting the next", async () => {
    let running = 0;
    let peak = 0;
    // 20 files; files 0, 5, 10 and 15 are slow (100 ms), one in every group of
    // five. In fixed groups of five each group would wait for its slow file, so
    // four groups would take about 400 ms. With a sliding window the slow files
    // run side by side and the quick ones flow through the free slot, about 100 ms.
    mockCreateBlob.mockImplementation(async ({ content }: { content: string }) => {
      const n = Number(Buffer.from(content, "base64").toString());
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, n % 5 === 0 ? 100 : 2));
      running--;
      return { data: { sha: `sha-${n}` } };
    });
    const files = Array.from({ length: 20 }, (_, i) => ({ path: `f${i}.txt`, content: b64(String(i)) }));

    const t0 = Date.now();
    const blobs = await createBlobs("fake-token", "me", "repo", files);

    expect(peak).toBe(5);
    expect(blobs.map((b) => b.sha)).toEqual(files.map((_, i) => `sha-${i}`));
    expect(Date.now() - t0).toBeLessThan(250);
  });

  it("explains a push-protection rejection instead of passing the raw error on", async () => {
    mockCreateBlob.mockRejectedValue(
      Object.assign(new Error("Secret detected"), { status: 422, response: { data: { message: "Secret detected" } } })
    );

    await expect(
      createBlobs("fake-token", "me", "repo", [{ path: "a.txt", content: b64("x") }])
    ).rejects.toThrow(/blocked this push because it detected a secret/i);
  });
});

describe("commitUpload", () => {
  const blobs = [
    { path: "index.js", sha: "a".repeat(40) },
    { path: "src/util.js", sha: "b".repeat(40) },
  ];

  it("builds one tree and one commit on the current branch head, then moves the branch", async () => {
    mockReposGet.mockResolvedValue({ data: { default_branch: "main" } });
    mockGetRef.mockResolvedValue({ data: { object: { sha: "existing-commit-sha" } } });
    mockGetCommit.mockResolvedValue({ data: { tree: { sha: "existing-tree-sha" } } });
    mockCreateTree.mockResolvedValue({ data: { sha: "new-tree-sha" } });
    mockCreateCommit.mockResolvedValue({ data: { sha: "final-commit-sha" } });
    mockUpdateRef.mockResolvedValue({ data: {} });

    const commit = await commitUpload("fake-token", "me", "normal-repo", blobs, "Upload files");

    expect(mockCreateTree).toHaveBeenCalledTimes(1);
    expect(mockCreateTree).toHaveBeenCalledWith(
      expect.objectContaining({
        base_tree: "existing-tree-sha",
        tree: blobs.map((b) => ({ path: b.path, mode: "100644", type: "blob", sha: b.sha })),
      })
    );
    expect(mockCreateCommit).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Upload files", tree: "new-tree-sha", parents: ["existing-commit-sha"] })
    );
    expect(mockUpdateRef).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "me", repo: "normal-repo", ref: "heads/main", sha: "final-commit-sha" })
    );
    expect(commit.sha).toBe("final-commit-sha");
  });

  it("puts small text files into the tree as inline content, with no blob call for them", async () => {
    mockReposGet.mockResolvedValue({ data: { default_branch: "main" } });
    mockGetRef.mockResolvedValue({ data: { object: { sha: "existing-commit-sha" } } });
    mockGetCommit.mockResolvedValue({ data: { tree: { sha: "existing-tree-sha" } } });
    mockCreateTree.mockResolvedValue({ data: { sha: "new-tree-sha" } });
    mockCreateCommit.mockResolvedValue({ data: { sha: "final-commit-sha" } });
    mockUpdateRef.mockResolvedValue({ data: {} });

    await commitUpload(
      "fake-token",
      "me",
      "repo",
      [{ path: "image.png", sha: "a".repeat(40) }, { path: "README.md", content: "# Hello\r\n" }],
      "Upload files"
    );

    expect(mockCreateBlob).not.toHaveBeenCalled();
    expect(mockCreateTree).toHaveBeenCalledWith(
      expect.objectContaining({
        tree: [
          { path: "image.png", mode: "100644", type: "blob", sha: "a".repeat(40) },
          { path: "README.md", mode: "100644", type: "blob", content: "# Hello\r\n" },
        ],
      })
    );
  });

  it.each([
    ["branch read", mockGetRef, 503, "GitHub unavailable"],
    ["unrelated conflict", mockGetRef, 409, "Another request changed the branch"],
    ["commit read", mockGetCommit, 409, "Git Repository is empty."],
  ] as const)("does not initialize a repository after a failed %s", async (_label, mock, status, message) => {
    mockReposGet.mockResolvedValue({ data: { default_branch: "main" } });
    mockGetRef.mockResolvedValue({ data: { object: { sha: "existing-commit-sha" } } });
    const error = Object.assign(new Error(message), { status });
    mock.mockRejectedValueOnce(error);

    await expect(commitUpload("fake-token", "me", "repo", blobs, "Upload files")).rejects.toBe(error);
    expect(mockCreateOrUpdateFileContents).not.toHaveBeenCalled();
    expect(mockCreateTree).not.toHaveBeenCalled();
    expect(mockUpdateRef).not.toHaveBeenCalled();
  });

  it("finalizes against the branch an empty-repo init created — updateRef, not createRef", async () => {
    mockReposGet.mockResolvedValue({ data: { default_branch: "main" } });
    mockGetRef.mockRejectedValueOnce(Object.assign(new Error("Git Repository is empty."), { status: 409 }));
    mockCreateOrUpdateFileContents.mockResolvedValue({ data: { commit: { sha: "init-commit-sha" } } });
    mockGetCommit.mockResolvedValue({ data: { tree: { sha: "init-tree-sha" } } });
    mockCreateTree.mockResolvedValue({ data: { sha: "new-tree-sha" } });
    mockCreateCommit.mockResolvedValue({ data: { sha: "final-commit-sha" } });
    mockUpdateRef.mockResolvedValue({ data: {} });

    await commitUpload("fake-token", "me", "empty-repo", blobs, "Upload files");

    const initOrder = mockCreateOrUpdateFileContents.mock.invocationCallOrder[0];
    const treeOrder = mockCreateTree.mock.invocationCallOrder[0];
    expect(initOrder).toBeLessThan(treeOrder);
    expect(mockCreateCommit).toHaveBeenCalledWith(expect.objectContaining({ parents: ["init-commit-sha"] }));
    expect(mockUpdateRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "heads/main", sha: "final-commit-sha" })
    );
  });
});
