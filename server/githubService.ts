import { Octokit } from "./octokit";
import { mapWithConcurrency } from "./pool";

export interface ExtractedFile {
  path: string;
  content: string; // base64 encoded
}

// The client uses only these fields. GitHub's full user and repository objects
// run to several KB each (dozens of URL fields, nested owner, permissions,
// license...), so the API forwards just what is shown.
export interface UserSummary {
  login: string;
  avatar_url: string;
}
export interface RepoSummary {
  id: number;
  name: string;
  full_name: string;
  /** Lets the client ask for the file tree without a lookup of the branch first. */
  default_branch?: string;
}
export interface RepoPage {
  repos: RepoSummary[];
  /** The next page number, or null when this was the last page. */
  nextPage: number | null;
}

export const toUserSummary = (u: any): UserSummary => ({ login: u.login, avatar_url: u.avatar_url });
export const toRepoSummary = (r: any): RepoSummary => ({
  id: r.id,
  name: r.name,
  full_name: r.full_name,
  default_branch: r.default_branch,
});

export const REPOS_PER_PAGE = 100;

// GitHub says whether another page exists in the Link header.
export const hasNextPage = (linkHeader: string | undefined | null): boolean =>
  !!linkHeader && /<[^>]*>;\s*rel="next"/.test(linkHeader);

// One page of repositories, most recently updated first. The list used to be
// fetched with octokit.paginate, which walks every page one after another
// before returning anything. Now the first page is enough to show the UI, and
// the client asks for further pages afterwards.
export const fetchRepositoryPage = async (token: string, page = 1): Promise<RepoPage> => {
  const octokit = new Octokit({ auth: token });
  const res = await octokit.rest.repos.listForAuthenticatedUser({
    sort: "updated",
    per_page: REPOS_PER_PAGE,
    page,
  });
  return {
    repos: res.data.map(toRepoSummary),
    nextPage: hasNextPage(res.headers?.link) ? page + 1 : null,
  };
};

export const fetchUser = async (token: string): Promise<UserSummary> => {
  const octokit = new Octokit({ auth: token });
  const { data } = await octokit.rest.users.getAuthenticated();
  return toUserSummary(data);
};

export const createRepository = async (token: string, name: string, isPrivate: boolean) => {
  const octokit = new Octokit({ auth: token });
  try {
    const { data } = await octokit.rest.repos.createForAuthenticatedUser({
      name,
      private: isPrivate,
      auto_init: false,
    });
    return data;
  } catch (error: any) {
    const status = error?.status;
    const apiMessage: string = error?.response?.data?.message || error?.message || "";
    if (status === 422 && /already exists|name already exists on this account/i.test(apiMessage)) {
      throw new Error(`A repository named "${name}" already exists on your account. Try a different name.`);
    }
    if (status === 422) {
      const detail = error?.response?.data?.errors?.[0]?.message;
      throw new Error(detail || apiMessage || "That repository name isn't valid. Try a different name.");
    }
    throw error;
  }
};

export const deleteRepository = async (token: string, owner: string, repo: string): Promise<void> => {
  const octokit = new Octokit({ auth: token });
  try {
    await octokit.rest.repos.delete({ owner, repo });
  } catch (error: any) {
    const status = error?.status;
    const apiMessage: string = error?.response?.data?.message || error?.message || "";
    if (status === 403 && /scope/i.test(apiMessage)) {
      throw new Error(
        "Your GitHub connection doesn't have permission to delete repositories. " +
        "Please disconnect and reconnect your GitHub account to grant the required access, then try again."
      );
    }
    throw error;
  }
};

export interface RepoTreeEntry {
  path: string;
  type: "blob" | "tree";
  sha: string;
  size?: number;
}

/**
 * True if `path` should be deleted given the user's selection: either it's an
 * exact match, or it sits inside a selected folder (path prefixed with
 * "selectedFolder/"). Exported and unit-tested on its own since this is the
 * logic that decides exactly what gets removed from a repo.
 */
export const isPathRemoved = (path: string, selectedPaths: string[]): boolean =>
  selectedPaths.some((rawSel) => {
    const sel = rawSel.replace(/\/$/, "");
    return path === sel || path.startsWith(sel + "/");
  });

const toTreeEntries = (items: any[] | undefined): RepoTreeEntry[] =>
  (items || [])
    .filter((item) => item.type === "blob" || item.type === "tree")
    .map((item) => ({
      path: item.path as string,
      type: item.type as "blob" | "tree",
      sha: item.sha as string,
      size: item.size,
    }));

// Most subfolders a truncated tree is walked folder by folder for. Each folder
// costs one API call, so a hard cap keeps a pathological repository from
// turning one click into thousands of requests.
const MAX_TREE_WALK_REQUESTS = 2000;
const TREE_WALK_CONCURRENCY = 8;

// GitHub cuts a recursive tree off at 100,000 entries or 7 MB and sets
// `truncated`. The documented way to get the rest is to list the tree one
// folder at a time. Used where a partial list would be wrong, not just
// incomplete (deleting), because files in the missing part would silently
// survive the deletion.
const walkTree = async (octokit: Octokit, owner: string, repo: string, rootSha: string): Promise<RepoTreeEntry[]> => {
  const all: RepoTreeEntry[] = [];
  let level: { sha: string; prefix: string }[] = [{ sha: rootSha, prefix: "" }];
  let requests = 0;

  while (level.length > 0) {
    requests += level.length;
    if (requests > MAX_TREE_WALK_REQUESTS) {
      throw new Error("This repository has too many folders to list completely.");
    }
    const listings = await mapWithConcurrency(level, TREE_WALK_CONCURRENCY, async ({ sha, prefix }) => {
      const { data } = await octokit.rest.git.getTree({ owner, repo, tree_sha: sha });
      if (data.truncated) {
        throw new Error("A folder in this repository is too large to list completely.");
      }
      return { prefix, items: toTreeEntries(data.tree) };
    });

    const next: { sha: string; prefix: string }[] = [];
    for (const { prefix, items } of listings) {
      for (const item of items) {
        const path = prefix + item.path;
        all.push({ ...item, path });
        if (item.type === "tree") next.push({ sha: item.sha, prefix: path + "/" });
      }
    }
    level = next;
  }
  return all;
};

/**
 * The file list for the Manage files view.
 *
 * With `knownBranch` (the client has default_branch from the repository list)
 * this is ONE request: getTree accepts a branch name, so there is no repos.get
 * to learn the branch and no getRef to learn the commit. Without it, or when
 * that one request cannot be answered (a renamed branch, say), it falls back to
 * repos.get + getTree, which also gives a proper "not found" or "no access"
 * error. getRef is not needed either way: getTree takes a branch name.
 *
 * `truncated` is true when GitHub cut the list off (100,000 entries or 7 MB):
 * what comes back is then only part of the repository.
 */
export const fetchRepoTree = async (
  token: string,
  owner: string,
  repo: string,
  knownBranch?: string
): Promise<{ tree: RepoTreeEntry[]; defaultBranch: string; truncated: boolean }> => {
  const octokit = new Octokit({ auth: token });

  const listBranch = async (branch: string) => {
    try {
      const { data } = await octokit.rest.git.getTree({ owner, repo, tree_sha: branch, recursive: "true" });
      return { tree: toTreeEntries(data.tree), defaultBranch: branch, truncated: !!data.truncated };
    } catch (err: any) {
      // GitHub answers 409 "Git Repository is empty" for a repository with no
      // commits. That is not an error for the user: there is nothing to browse.
      if (err?.status === 409) return { tree: [], defaultBranch: branch, truncated: false };
      throw err;
    }
  };

  if (knownBranch) {
    try {
      return await listBranch(knownBranch);
    } catch {
      // Fall through: the slow path re-reads the real default branch and
      // reports a real error if the repository itself is the problem.
    }
  }

  const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
  return listBranch(repoData.default_branch || "main");
};

// GitHub's Git Data API reports an empty repository with this specific 409.
const isEmptyRepoError = (err: any): boolean => {
  const message = err?.response?.data?.message ?? err?.message;
  return err?.status === 409 && typeof message === "string" && /^Git Repository is empty\.?$/i.test(message.trim());
};

const readBranchHead = async (octokit: Octokit, owner: string, repo: string, branch: string): Promise<string | null> => {
  try {
    const { data } = await octokit.rest.git.getRef({ owner, repo, ref: "heads/" + branch });
    return data.object.sha;
  } catch (error) {
    if (isEmptyRepoError(error)) return null;
    throw error;
  }
};

// What deleting needs: the default branch, the commit it points at (so the
// commit that follows is built on exactly what was listed) and the COMPLETE
// tree. Unlike the browse list, a truncated listing is completed here.
const readHeadTree = async (
  octokit: Octokit,
  owner: string,
  repo: string
): Promise<{ tree: RepoTreeEntry[]; defaultBranch: string; headSha: string | null }> => {
  const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
  const defaultBranch = repoData.default_branch || "main";

  const headSha = await readBranchHead(octokit, owner, repo, defaultBranch);
  if (!headSha) return { tree: [], defaultBranch, headSha: null };

  const { data: treeData } = await octokit.rest.git.getTree({
    owner,
    repo,
    tree_sha: headSha,
    recursive: "true",
  });

  const tree = treeData.truncated
    ? await walkTree(octokit, owner, repo, headSha)
    : toTreeEntries(treeData.tree);

  // Exposing the ref SHA we already fetched lets callers (e.g. deleteRepoPaths)
  // avoid a redundant getRef round trip — and the TOCTOU window that comes
  // with reading the ref twice.
  return { tree, defaultBranch, headSha };
};

export const deleteRepoPaths = async (
  token: string,
  owner: string,
  repo: string,
  selectedPaths: string[],
  commitMessage: string,
  onProgress?: (status: string) => void
) => {
  const octokit = new Octokit({ auth: token });

  onProgress?.("Fetching repository details...");
  const { tree, defaultBranch, headSha } = await readHeadTree(octokit, owner, repo);
  const branchRef = `heads/${defaultBranch}`;

  if (!headSha) {
    throw new Error("This repository has no commits yet, so there's nothing to delete.");
  }

  // Reuse the ref SHA readHeadTree already read instead of calling getRef
  // again — avoids a redundant round trip and the small TOCTOU window that
  // came from reading the ref twice.
  const commitSha = headSha;
  const { data: commitData } = await octokit.rest.git.getCommit({ owner, repo, commit_sha: commitSha });
  const baseTreeSha = commitData.tree.sha;

  const isRemoved = (path: string) => isPathRemoved(path, selectedPaths);

  const totalBlobs = tree.filter((e) => e.type === "blob").length;
  const remainingBlobs = tree.filter((entry) => entry.type === "blob" && !isRemoved(entry.path));

  if (remainingBlobs.length === totalBlobs) {
    throw new Error("None of the selected paths were found in the repository.");
  }

  onProgress?.("Building updated file tree...");
  const deletionTreeItems = tree
    .filter((entry) => entry.type === "blob" && isRemoved(entry.path))
    .map((entry) => ({
      path: entry.path,
      mode: "100644" as const,
      type: "blob" as const,
      sha: null,
    }));

  const { data: newTree } = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: baseTreeSha,
    tree: deletionTreeItems,
  });

  onProgress?.("Committing deletion...");
  const { data: newCommit } = await octokit.rest.git.createCommit({
    owner,
    repo,
    message: commitMessage,
    tree: newTree.sha,
    parents: [commitSha],
  });

  onProgress?.("Updating branch...");
  await octokit.rest.git.updateRef({
    owner,
    repo,
    ref: branchRef,
    sha: newCommit.sha,
  });

  return newCommit;
};

// --- Batched upload --- //
// A push is two kinds of request instead of one giant one, so no single request
// has to carry the whole ZIP as one base64 JSON body:
//   1. createBlobs   - once per batch of files: store the file contents on GitHub
//   2. commitUpload  - once: one tree, one commit and the branch update
// Nothing is kept on our server between the requests. GitHub stores the blobs
// (content-addressed, so re-sending a batch is harmless, and blobs that never
// reach a commit are garbage-collected) and the client carries the small
// {path, sha} list from step 1 to step 2. Small text files skip step 1: the
// client sends their text with the commit and GitHub makes the blob while it
// builds the tree, which saves one API call per file.

export interface BlobEntry {
  path: string;
  sha: string;
}

/** One line of the final tree: a file already stored as a blob, or a small text file sent inline. */
export type TreeEntry = BlobEntry | { path: string; content: string };

// Finds the default branch and its current head, first making the one initial
// commit that an empty repository needs.
const resolveHead = async (octokit: Octokit, owner: string, repo: string) => {
  const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
  const defaultBranch = repoData.default_branch || "main";
  const branchRef = `heads/${defaultBranch}`;

  let commitSha = await readBranchHead(octokit, owner, repo, defaultBranch);
  if (commitSha === null) {
    // The Contents API can create the first commit. Git Data API calls work
    // once that first commit exists.
    const initReadme = `# ${repo}\n\nCreated with ZiptoGit.\n`;
    const { data: initData } = await octokit.rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: "README.md",
      message: "Initial commit",
      content: Buffer.from(initReadme, "utf-8").toString("base64"),
      branch: defaultBranch,
    });

    if (!initData.commit?.sha) {
      throw new Error("Failed to initialize the empty repository (no commit SHA returned).");
    }
    commitSha = initData.commit.sha;
  }

  const { data: commitData } = await octokit.rest.git.getCommit({ owner, repo, commit_sha: commitSha });
  return { branchRef, commitSha, baseTreeSha: commitData.tree.sha };
};

// GitHub's push protection can reject blobs and commits that contain a secret
// our client-side scanner missed; say what happened instead of passing the raw error on.
const explainUploadError = (error: any): never => {
  const apiMessage: string = error?.response?.data?.message || error?.message || "";
  if (/push protection|secret/i.test(apiMessage)) {
    throw new Error(
      "GitHub blocked this push because it detected a secret that our scanner missed. " +
      "Please remove it from the ZIP and try again. (" + apiMessage + ")"
    );
  }
  throw error;
};

const createBlobWithRetry = async (
  octokit: Octokit,
  owner: string,
  repo: string,
  file: ExtractedFile,
  retries = 3,
  delay = 1000
): Promise<any> => {
  try {
    const { data } = await octokit.rest.git.createBlob({
      owner,
      repo,
      content: file.content,
      encoding: "base64",
    });
    return data;
  } catch (err: any) {
    if (retries > 0 && (err.status === 403 || err.status >= 500)) {
      const waitTime = err.response?.headers?.["retry-after"]
        ? parseInt(err.response.headers["retry-after"], 10) * 1000
        : delay;
      await new Promise((r) => setTimeout(r, waitTime || delay));
      return createBlobWithRetry(octokit, owner, repo, file, retries - 1, delay * 2);
    }
    throw err;
  }
};

// How many blobs are being created at once. GitHub throttles bursts of
// content-creating calls, so this stays modest.
const MAX_CONCURRENT_BLOBS = 5;

/**
 * Step 1: stores one batch of files as blobs and returns their SHAs, in the
 * same order. Files are processed with a sliding window, so one slow or retried
 * file does not hold up the others.
 *
 * Nothing about the repository is looked up first: the usual repo already
 * accepts blobs. Only if GitHub says the repo is empty is it initialized (once,
 * however many files hit that at the same moment), and then the file is retried.
 */
export const createBlobs = async (
  token: string,
  owner: string,
  repo: string,
  files: ExtractedFile[]
): Promise<BlobEntry[]> => {
  const octokit = new Octokit({ auth: token });
  let initialization: Promise<unknown> | null = null;

  try {
    return await mapWithConcurrency(files, MAX_CONCURRENT_BLOBS, async (file): Promise<BlobEntry> => {
      let blob: any;
      try {
        blob = await createBlobWithRetry(octokit, owner, repo, file);
      } catch (err: any) {
        if (!isEmptyRepoError(err)) throw err;
        initialization ??= resolveHead(octokit, owner, repo);
        await initialization;
        blob = await createBlobWithRetry(octokit, owner, repo, file);
      }
      return { path: file.path, sha: blob.sha as string };
    });
  } catch (error: any) {
    return explainUploadError(error);
  }
};

/**
 * Step 2: one tree, one commit and the branch update for everything the blob
 * batches stored, plus any small text files sent inline (GitHub creates those
 * blobs itself while building the tree). The branch head is looked up here, at
 * commit time, so the commit is built on whatever the branch is now rather than
 * on how it looked when the push began.
 */
export const commitUpload = async (
  token: string,
  owner: string,
  repo: string,
  entries: TreeEntry[],
  commitMessage: string
) => {
  const octokit = new Octokit({ auth: token });

  try {
    const { branchRef, commitSha, baseTreeSha } = await resolveHead(octokit, owner, repo);

    const { data: newTree } = await octokit.rest.git.createTree({
      owner,
      repo,
      base_tree: baseTreeSha,
      tree: entries.map((e) =>
        "sha" in e
          ? { path: e.path, mode: "100644" as const, type: "blob" as const, sha: e.sha }
          : { path: e.path, mode: "100644" as const, type: "blob" as const, content: e.content }
      ),
    });

    const { data: newCommit } = await octokit.rest.git.createCommit({
      owner,
      repo,
      message: commitMessage,
      tree: newTree.sha,
      parents: [commitSha],
    });

    // commitSha is always set by this point — either the branch already existed,
    // or the Contents-API init step just created it — so this is always an
    // update to an existing branch, never creating a brand new one.
    await octokit.rest.git.updateRef({ owner, repo, ref: branchRef, sha: newCommit.sha });

    return newCommit;
  } catch (error: any) {
    return explainUploadError(error);
  }
};
