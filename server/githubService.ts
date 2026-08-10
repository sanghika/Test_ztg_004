import { Octokit } from "octokit";

export interface ExtractedFile {
  path: string;
  content: string; // base64 encoded
}

export const fetchRepositories = async (token: string) => {
  const octokit = new Octokit({ auth: token });
  return await octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, {
    sort: "updated",
    per_page: 100,
  });
};

export const fetchUser = async (token: string) => {
  const octokit = new Octokit({ auth: token });
  const { data } = await octokit.rest.users.getAuthenticated();
  return data;
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

export const fetchRepoTree = async (
  token: string,
  owner: string,
  repo: string
): Promise<{ tree: RepoTreeEntry[]; defaultBranch: string; headSha: string | null }> => {
  const octokit = new Octokit({ auth: token });

  const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
  const defaultBranch = repoData.default_branch || "main";

  let refData;
  try {
    ({ data: refData } = await octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${defaultBranch}`,
    }));
  } catch {
    // A repo with zero commits has no ref to read — that's not an error from
    // the user's point of view, it just means there's nothing to browse yet.
    return { tree: [], defaultBranch, headSha: null };
  }

  const { data: treeData } = await octokit.rest.git.getTree({
    owner,
    repo,
    tree_sha: refData.object.sha,
    recursive: "true",
  });

  const tree: RepoTreeEntry[] = (treeData.tree || [])
    .filter((item) => item.type === "blob" || item.type === "tree")
    .map((item) => ({
      path: item.path as string,
      type: item.type as "blob" | "tree",
      sha: item.sha as string,
      size: item.size,
    }));

  // Exposing the ref SHA we already fetched lets callers (e.g. deleteRepoPaths)
  // avoid a redundant getRef round trip — and the TOCTOU window that comes
  // with reading the ref twice.
  return { tree, defaultBranch, headSha: refData.object.sha };
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
  const { tree, defaultBranch, headSha } = await fetchRepoTree(token, owner, repo);
  const branchRef = `heads/${defaultBranch}`;

  if (!headSha) {
    throw new Error("This repository has no commits yet, so there's nothing to delete.");
  }

  // Reuse the ref SHA fetchRepoTree already read instead of calling getRef
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

export const uploadToGitHub = async (
  token: string,
  owner: string,
  repo: string,
  inputFiles: ExtractedFile[],
  commitMessage: string,
  onProgress: (status: string, current: number, total: number) => void
) => {
  const octokit = new Octokit({ auth: token });
  const files = inputFiles;
  const totalSteps = files.length + 3;
  let currentStep = 0;

  try {
    onProgress("Fetching repository details...", ++currentStep, totalSteps);
    const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
    const defaultBranch = repoData.default_branch || "main";
    const branchRef = `heads/${defaultBranch}`;

    let commitSha: string | null = null;
    let baseTreeSha: string | undefined = undefined;

    try {
      const { data: refData } = await octokit.rest.git.getRef({ owner, repo, ref: branchRef });
      commitSha = refData.object.sha;

      const { data: commitData } = await octokit.rest.git.getCommit({ owner, repo, commit_sha: commitSha });
      baseTreeSha = commitData.tree.sha;
    } catch (e: any) {
      // A brand-new repo with zero commits has no ref to read yet. GitHub's Git
      // Data API (the blob/tree/commit/ref calls used below) returns 409 "Git
      // Repository is empty" for EVERY one of those endpoints on a repo in this
      // state, not just this one — confirmed by GitHub's own docs:
      // https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-your-git-database
      // The documented way around it is to make one initial commit through the
      // simpler Contents API first, which is allowed to touch an empty repo and
      // creates the branch. Everything after that behaves like a normal repo.
      console.warn("Repository appears empty. Initializing via the Contents API before using the Git Data API.", e?.message);
      onProgress("Initializing empty repository...", currentStep, totalSteps);

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
      const { data: commitData } = await octokit.rest.git.getCommit({ owner, repo, commit_sha: commitSha });
      baseTreeSha = commitData.tree.sha;
    }

    const createBlobWithRetry = async (file: ExtractedFile, retries = 3, delay = 1000): Promise<any> => {
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
          return createBlobWithRetry(file, retries - 1, delay * 2);
        }
        throw err;
      }
    };

    const treeItems: any[] = [];
    const MAX_CONCURRENT_UPLOADS = 5;

    for (let i = 0; i < files.length; i += MAX_CONCURRENT_UPLOADS) {
      const batch = files.slice(i, i + MAX_CONCURRENT_UPLOADS);
      const promises = batch.map(async (file) => {
        const blobData = await createBlobWithRetry(file);
        return {
          path: file.path,
          mode: "100644" as const,
          type: "blob" as const,
          sha: blobData.sha,
        };
      });

      const batchResults = await Promise.all(promises);
      treeItems.push(...batchResults);

      currentStep += batch.length;
      onProgress(`Uploading files (${Math.min(currentStep, totalSteps - 2)}/${totalSteps - 2})...`, Math.min(currentStep, totalSteps - 2), totalSteps);
    }

    onProgress("Creating project tree...", ++currentStep, totalSteps);
    const treeOptions: any = { owner, repo, tree: treeItems };
    if (baseTreeSha) treeOptions.base_tree = baseTreeSha;
    const { data: newTree } = await octokit.rest.git.createTree(treeOptions);

    onProgress("Committing changes...", ++currentStep, totalSteps);
    const { data: newCommit } = await octokit.rest.git.createCommit({
      owner,
      repo,
      message: commitMessage,
      tree: newTree.sha,
      parents: [commitSha],
    });

    onProgress("Finalizing...", ++currentStep, totalSteps);
    // commitSha is always set by this point — either the branch already existed,
    // or the Contents-API init step above just created it — so this is always
    // an update to an existing branch now, never creating a brand new one.
    await octokit.rest.git.updateRef({ owner, repo, ref: branchRef, sha: newCommit.sha });

    return newCommit;
  } catch (error: any) {
    const apiMessage: string = error?.response?.data?.message || error?.message || "";
    if (/push protection|secret/i.test(apiMessage)) {
      throw new Error(
        "GitHub blocked this push because it detected a secret that our scanner missed. " +
        "Please remove it from the ZIP and try again. (" + apiMessage + ")"
      );
    }
    throw error;
  }
};
