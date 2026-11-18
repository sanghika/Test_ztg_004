import { Component, useState, useEffect, useLayoutEffect, useMemo, useRef, useId, lazy, Suspense } from "react";
import { fetchRepositories, type BootstrapData, type RepoSummary, warmZipExtractor, extractZip, extractFolder, filesFromDataTransferItems, uploadToGitHub, ExtractedFile, fetchRepoTree, deleteRepoPaths, deleteRepository, createRepository, logout as apiLogout, RepoTreeEntry } from "./lib/github";
import { trackEvent } from "./lib/analytics";
import { mergeRepos } from "./lib/repos";
import { SECRET_SCAN_NOTE } from "./lib/uploadLimits";
import type { SanitizeReport } from "./lib/secretScanner";
import { avatarSrc, AVATAR_PX } from "./lib/avatar";
import { Alert, CARD_EDGE, CTRL, StepBadge, T, useMediaQuery, type StepStatus } from "./components/ui";
import { LogOut, Upload, Loader2, CheckCircle, AlertCircle, FileArchive, X, Check, ChevronDown, Folder, FolderOpen, Trash2, ShieldCheck, Plus, Lock, Globe, ExternalLink } from "lucide-react";

export { fetchBootstrap } from "./lib/github";

// Load the scanner on Push and the file tree when Manage files opens.
const loadSecretScanner = () => import("./lib/secretScanner");
const loadRepoFileTree = () => import("./components/RepoFileTree");
const RepoFileTree = lazy(loadRepoFileTree);

class RepoFileTreeErrorBoundary extends Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <Alert variant="error" className="mb-3">
        <p>Couldn’t open the file list.</p>
        <button type="button" className="mt-2 underline" onClick={() => window.location.reload()}>
          Reload page
        </button>
      </Alert>
    );
  }
}

type UploadSource = { kind: "zip" | "folder"; name: string };

// Sentinel value for the "Create new repository" option in the repo <select>.
// Never a real full_name, so it can't collide with an actual repo.
const CREATE_NEW_REPO_VALUE = "__create_new_repo__";

// Suggest a name based on the repositories loaded in the picker.
function suggestRepoName(existingRepos: RepoSummary[]): string {
  const takenNames = new Set(existingRepos.map((repo) => repo.name.toLowerCase()));
  let i = 1;
  while (takenNames.has(`ziptogit.in_new${i}`.toLowerCase())) i++;
  return `ziptogit.in_new${i}`;
}

// GitHub repo names allow letters, numbers, '.', '-', '_' only.
const REPO_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

// Controls: every button, input and select is 44px tall (see the spacing rules
// in index.css). BTN is the shared shape; colour comes from BTN_PRIMARY /
// BTN_SECONDARY / BTN_DANGER below. Text size is set where it is used (text-sm
// everywhere except the two page-level CTAs, which are text-base).
const BTN = `${CTRL} px-4 font-medium inline-flex items-center justify-center gap-2`;
const FIELD = `${CTRL} w-full px-4 text-sm bg-input text-slate-900 dark:text-slate-100`;

// The two dashboard views. The desktop sidebar, the phone's segmented switch AND
// each view's h1 render from this list, so a destination has exactly one name.
// (Push view: "Push files" in the nav, the h1 and the main button. Manage view:
// "Manage files" in the nav and the h1. There is no breadcrumb: it only repeated
// the nav and its first crumb pointed at a dashboard that does not exist.)
const VIEWS = [
  { id: "push", label: "Push files", icon: Upload },
  { id: "manage", label: "Manage files", icon: FolderOpen },
] as const;

// Filled primary button. Disabled is a distinct flat style (6.1-6.2:1 text in both
// themes, via the disabled / on-disabled tokens in index.css), not
// "the same button at 50% opacity", and it never gets a hover.
const BTN_PRIMARY =
  "bg-primary text-on-primary transition-colors enabled:hover:bg-primary-hover disabled:cursor-not-allowed disabled:bg-disabled disabled:text-on-disabled";


// The page's main action ("Push files"). Same as BTN_PRIMARY, but while it is
// waiting for the repository and files it stays brand-tinted (cta-disabled /
// on-cta-disabled tokens, 6.3:1 light, 6.5:1 dark) instead of going flat grey, so
// it still reads as the action the page is building towards.
const BTN_CTA =
  "bg-primary text-on-primary transition-colors enabled:hover:bg-primary-hover disabled:cursor-not-allowed disabled:bg-cta-disabled disabled:text-on-cta-disabled";

// Secondary (outlined) and destructive buttons. Destructive comes in two weights:
// BTN_DANGER (solid red) is for the irreversible actions ("Delete repository…",
// "Delete forever"); BTN_DANGER_OUTLINE (red outline) is for the reversible
// "Delete selected" (it is a commit; the files stay in the repository's history).
const BTN_SECONDARY =
  "bg-input text-slate-700 dark:text-slate-200 border border-field transition-colors hover:bg-tint-2";
const BTN_DANGER =
  "bg-red-700 text-white transition-colors enabled:hover:bg-red-800 disabled:cursor-not-allowed disabled:bg-disabled disabled:text-on-disabled";
// Colours are all behind `enabled:` so the flat disabled style (the base classes)
// cannot be overridden by a dark: variant.
const BTN_DANGER_OUTLINE =
  "border border-transparent bg-disabled text-on-disabled transition-colors disabled:cursor-not-allowed enabled:bg-transparent enabled:border-red-500 dark:enabled:border-red-400/60 enabled:text-red-700 dark:enabled:text-red-300 enabled:hover:bg-red-50 dark:enabled:hover:bg-red-500/10";

// The ONE Cancel button. Always the secondary style, always first in its row,
// always half the row (flex-1) next to the action it cancels.
function CancelButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${BTN} ${BTN_SECONDARY} flex-1 text-sm disabled:opacity-50 disabled:cursor-not-allowed`}
    >
      Cancel
    </button>
  );
}

// Heading for the Repository -> Files steps that lead to the Push button.
function StepHeader({ n, title, status, titleId }: { n: number; title: string; status: StepStatus; titleId?: string }) {
  return (
    <div className="flex items-center gap-3 mb-3">
      <StepBadge n={n} status={status} />
      <h2
        className={`${T.title} ${
          status === "upcoming" ? "text-muted" : "text-slate-900 dark:text-slate-100"
        }`}
      >
        <span className="sr-only">Step {n}{status === "done" ? " (complete)" : ""}: </span>
        <span id={titleId}>{title}</span>
      </h2>
    </div>
  );
}

// One sidebar entry. This is navigation between two views, so it has a real
// active state (aria-current) shown with exactly two cues: a tinted fill and ink
// text/icon against the muted inactive rows. No ring, bar or extra weight.
function SidebarItem({
  active,
  icon: Icon,
  onClick,
  children,
}: {
  active: boolean;
  icon: React.ComponentType<{ className?: string }>;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-3 h-11 text-sm font-medium rounded-control px-3 text-left transition-colors ${
        active
          ? "bg-tint-3 text-ink dark:text-white"
          : "text-muted hover:bg-tint-2 hover:text-ink dark:hover:text-white"
      }`}
    >
      <Icon className="w-4 h-4" />
      {children}
    </button>
  );
}

export default function Dashboard({ account, onDisconnect }: { account: BootstrapData; onDisconnect: () => void }) {
  const { user, repos: firstPage, nextPage } = account;
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [logoutFailed, setLogoutFailed] = useState(false);
  const [repos, setRepos] = useState(firstPage);
  const [nextRepoPage, setNextRepoPage] = useState(nextPage);
  const [isLoadingMoreRepos, setIsLoadingMoreRepos] = useState(false);
  const [repoListError, setRepoListError] = useState<string | null>(null);
  const repoPageRequest = useRef<AbortController | null>(null);
  const [selectedRepoFullId, setSelectedRepoFullId] = useState(firstPage[0]?.full_name ?? "");
  // The default branch comes with the repository list, and passing it to the
  // file-tree request saves the server two GitHub round trips. A ref, so the
  // tree effect reads the current list without re-running every time another
  // page of repositories arrives.
  const reposRef = useRef(repos);
  reposRef.current = repos;
  const defaultBranchOf = (fullName: string): string | undefined =>
    reposRef.current.find((repo) => repo.full_name === fullName)?.default_branch || undefined;

  // --- Create a new repository directly from the dropdown --- //
  const [isCreatingRepo, setIsCreatingRepo] = useState(false);
  const [newRepoName, setNewRepoName] = useState("");
  const [newRepoIsPrivate, setNewRepoIsPrivate] = useState(false); // defaults to public
  const [isSubmittingNewRepo, setIsSubmittingNewRepo] = useState(false);
  const [createRepoErrorMsg, setCreateRepoErrorMsg] = useState<string | null>(null);

  // Tracks whichever source is currently loaded — a ZIP file or a picked/dropped
  // folder — since both feed the same extractedFiles pipeline below.
  const [selectedSource, setSelectedSource] = useState<UploadSource | null>(null);
  const sourceVersion = useRef(0);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [extractedFiles, setExtractedFiles] = useState<ExtractedFile[]>([]);
  const [isExtracting, setIsExtracting] = useState(false);
  const [isReadingFolder, setIsReadingFolder] = useState(false);
  const [extractingName, setExtractingName] = useState("");

  const [isUploading, setIsUploading] = useState(false);
  const [uploadStatusMsg, setUploadStatusMsg] = useState("");
  const [uploadProgress, setUploadProgress] = useState({ current: 0, total: 0 });
  const [uploadSuccessUrl, setUploadSuccessUrl] = useState<string | null>(null);
  // What the success panel shows after a push (counts + commit), and any push-specific error.
  const [pushResult, setPushResult] = useState<{
    repo: string; fileCount: number; skipped: number; redacted: number; commitSha?: string; commitUrl?: string;
  } | null>(null);
  const [pushErrorMsg, setPushErrorMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [secretWarningMsg, setSecretWarningMsg] = useState<string | null>(null);
  const [pendingScan, setPendingScan] = useState<{ sanitized: ExtractedFile[]; report: SanitizeReport } | null>(null);

  // --- File/folder deletion (manage existing repo contents) --- //
  // Which view the dashboard shows. "manage" is the file manager + danger zone;
  // it used to be an inline toggle, now it is a proper view in the sidebar.
  const [view, setView] = useState<"push" | "manage">("push");
  const [treeReloadKey, setTreeReloadKey] = useState(0);
  const [repoTree, setRepoTree] = useState<RepoTreeEntry[]>([]);
  // GitHub cuts the file list off for very large repositories; then the tree
  // shown is only part of the repository.
  const [treeTruncated, setTreeTruncated] = useState(false);
  const [isLoadingTree, setIsLoadingTree] = useState(false);
  const [treeErrorMsg, setTreeErrorMsg] = useState<string | null>(null);
  const [selectedDeletePaths, setSelectedDeletePaths] = useState<Set<string>>(new Set());
  const [deletingFrom, setDeletingFrom] = useState<string | null>(null);
  const isDeleting = deletingFrom !== null;
  const [deleteStatusMsg, setDeleteStatusMsg] = useState("");
  const [deleteSuccessMsg, setDeleteSuccessMsg] = useState<string | null>(null);

  // --- Delete entire repository (danger zone) --- //
  const [showDeleteRepoConfirm, setShowDeleteRepoConfirm] = useState(false);
  const [deleteRepoConfirmText, setDeleteRepoConfirmText] = useState("");
  const [isDeletingRepo, setIsDeletingRepo] = useState(false);
  const [deleteRepoErrorMsg, setDeleteRepoErrorMsg] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const repoSelectRef = useRef<HTMLSelectElement>(null);

  // Ids that tie visible labels to their controls and regions.
  const repoSelectId = useId();
  const repoLabelId = useId();
  const filesLabelId = useId();
  const newRepoNameId = useId();
  const deleteConfirmHintId = useId();

  const canLoadMoreRepos = !isLoadingMoreRepos && !isUploading && !isCreatingRepo && !isSubmittingNewRepo && !isDeletingRepo;
  const loadMoreRepos = async () => {
    if (nextRepoPage === null || !canLoadMoreRepos || repoPageRequest.current) return;
    const request = new AbortController();
    repoPageRequest.current = request;
    setIsLoadingMoreRepos(true);
    setRepoListError(null);
    try {
      const result = await fetchRepositories(nextRepoPage, request.signal);
      if (request.signal.aborted) return;
      setRepos((prev) => mergeRepos(prev, result.repos));
      setNextRepoPage(result.nextPage);
    } catch (err) {
      if (request.signal.aborted) return;
      console.error(err);
      setRepoListError("Could not load more repositories. Try again.");
    } finally {
      if (repoPageRequest.current === request) {
        repoPageRequest.current = null;
        setIsLoadingMoreRepos(false);
      }
    }
  };

  useEffect(() => () => {
    sourceVersion.current++;
    repoPageRequest.current?.abort();
    repoPageRequest.current = null;
  }, []);

  const clearPushResult = () => {
    setUploadSuccessUrl(null);
    setPushResult(null);
    setPushErrorMsg(null);
    setSecretWarningMsg(null);
    setPendingScan(null);
  };

  // Resets everything tied to "which repo is selected" — shared by both the
  // normal repo-switch path and the newly-created-repo path so they can't
  // drift out of sync with each other.
  const resetRepoScopedState = () => {
    clearPushResult();
    setRepoTree([]);
    setTreeTruncated(false);
    setSelectedDeletePaths(new Set());
    setDeleteSuccessMsg(null);
    setTreeErrorMsg(null);
    setShowDeleteRepoConfirm(false);
    setDeleteRepoConfirmText("");
    setDeleteRepoErrorMsg(null);
  };

  const handleRepoSelectChange = (value: string) => {
    if (value === CREATE_NEW_REPO_VALUE) {
      setCreateRepoErrorMsg(null);
      setNewRepoName(suggestRepoName(repos));
      setNewRepoIsPrivate(false);
      setIsCreatingRepo(true);
      // The "create new repo" panel replaces the repo-scoped view entirely,
      // so anything tied to the previously-selected repo (an open file
      // manager, its loaded tree, a leftover secret-scan warning) needs to
      // be cleared here too — otherwise it stays visible behind/after the
      // panel closes, looking like stale or broken state.
      resetRepoScopedState();
      return;
    }
    setIsCreatingRepo(false);
    setSelectedRepoFullId(value);
    resetRepoScopedState();
  };

  const handleCancelCreateRepo = () => {
    setIsCreatingRepo(false);
    setCreateRepoErrorMsg(null);
  };

  const handleCreateRepo = async () => {
    const name = newRepoName.trim();
    if (!name) {
      setCreateRepoErrorMsg("Please enter a repository name.");
      return;
    }
    if (!REPO_NAME_PATTERN.test(name)) {
      setCreateRepoErrorMsg("Repository names can only contain letters, numbers, periods, hyphens and underscores.");
      return;
    }
    setIsSubmittingNewRepo(true);
    setCreateRepoErrorMsg(null);
    try {
      const repo = await createRepository(name, newRepoIsPrivate);
      trackEvent("repo_created", { is_private: newRepoIsPrivate });
      setRepos((prev) => mergeRepos([repo], prev));
      setSelectedRepoFullId(repo.full_name);
      resetRepoScopedState();
      setIsCreatingRepo(false);
    } catch (err: any) {
      setCreateRepoErrorMsg(err.message || "Failed to create the repository.");
    } finally {
      setIsSubmittingNewRepo(false);
    }
  };

  const logout = async () => {
    if (isLoggingOut) return;
    setIsLoggingOut(true);
    setLogoutFailed(false);
    try {
      await apiLogout();
      onDisconnect();
    } catch {
      setLogoutFailed(true);
    } finally {
      setIsLoggingOut(false);
    }
  };

  const extractSource = async (
    source: UploadSource,
    read: (onProgress: (path: string) => void) => Promise<ExtractedFile[]>
  ) => {
    const version = ++sourceVersion.current;
    setSelectedSource(source);
    setExtractedFiles([]);
    setErrorMsg(null);
    clearPushResult();
    setIsReadingFolder(false);
    setIsExtracting(true);
    setExtractingName("");

    let nextUpdate = 0;
    const onProgress = (path: string) => {
      const now = performance.now();
      if (sourceVersion.current !== version || now < nextUpdate) return;
      setExtractingName(path);
      nextUpdate = now + 100;
    };
    try {
      const files = await read(onProgress);
      if (sourceVersion.current === version) setExtractedFiles(files);
    } catch (err) {
      if (sourceVersion.current !== version) return;
      console.error(err);
      const fallback = source.kind === "zip" ? "Failed to extract ZIP." : "Failed to read the selected folder.";
      setErrorMsg(err instanceof Error && err.message ? err.message : fallback);
      setSelectedSource(null);
    } finally {
      if (sourceVersion.current === version) setIsExtracting(false);
    }
  };

  const processFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.type !== "application/zip" && !file.name.endsWith(".zip")) {
      setErrorMsg("Please select a valid ZIP file.");
      return;
    }
    trackEvent("zip_uploaded", { size_bytes: file.size, file_name: file.name });
    await extractSource({ kind: "zip", name: file.name }, (progress) => extractZip(file, progress));
  };

  const processFolder = async (files: File[], folderName: string) => {
    if (!files.length) return;
    trackEvent("folder_uploaded", { file_count: files.length, folder_name: folderName });
    await extractSource({ kind: "folder", name: folderName }, (progress) => extractFolder(files, progress));
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // Reset input to allow selecting the same file again
    await processFile(file);
  };

  const handleFolderChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    const files = fileList ? Array.from(fileList) : [];
    e.target.value = ''; // Reset input to allow selecting the same folder again
    if (files.length === 0) return;
    // webkitRelativePath looks like "my-project/src/App.tsx" — take the
    // first segment as the folder's display name.
    const folderName = ((files[0] as any).webkitRelativePath || files[0].name).split("/")[0];
    await processFolder(files, folderName);
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (isDraggingFile) return;
    setIsDraggingFile(true);
    // Some browsers expose only the MIME type until drop. An untyped ZIP
    // still starts extraction normally once the file is available.
    if (Array.from(e.dataTransfer.items).some(item =>
      item.kind === "file" && (item.type === "application/zip" || item.type === "application/x-zip-compressed")
    )) warmZipExtractor();
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    // Only clear once the pointer actually leaves the drop zone, not when it
    // crosses into a child element (which also fires dragleave on the parent).
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDraggingFile(false);
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDraggingFile(false);

    // A dropped folder arrives as a single DataTransferItem whose entry is a
    // directory — detect that first and walk it recursively. Otherwise fall
    // back to the plain file (ZIP) path, same as before.
    const item = e.dataTransfer.items?.[0];
    const entry = item?.kind === "file" ? item.webkitGetAsEntry?.() : null;
    if (entry && entry.isDirectory) {
      // Walking a folder's entries can take a moment before extraction even
      // starts (nothing was visibly "loading" here before, which made it
      // look like the drop had silently failed) — show feedback immediately.
      const version = ++sourceVersion.current;
      setIsReadingFolder(true);
      try {
        const files = await filesFromDataTransferItems(e.dataTransfer.items);
        if (sourceVersion.current === version) await processFolder(files, entry.name);
      } finally {
        if (sourceVersion.current === version) setIsReadingFolder(false);
      }
      return;
    }

    const file = e.dataTransfer.files?.[0];
    await processFile(file);
  };

  const handleUpload = async () => {
    if (isUploading || !selectedRepoFullId || !selectedSource || isExtracting || extractedFiles.length === 0 || isCreatingRepo) return;

    // If it was already successful, open the link instead
    if (uploadSuccessUrl) {
      window.open(uploadSuccessUrl, "_blank");
      return;
    }

    setIsUploading(true);
    setPushErrorMsg(null);
    setUploadStatusMsg(pendingScan ? "Starting upload…" : "Checking files…");
    setUploadProgress({ current: 0, total: 0 });
    const [owner, repo] = selectedRepoFullId.split("/");
    const version = sourceVersion.current;

    let scan = pendingScan;
    if (!scan) {
      try {
        const { sanitizeFiles } = await loadSecretScanner();
        scan = await sanitizeFiles(extractedFiles);
      } catch (err) {
        console.error("Could not scan files:", err);
        setPushErrorMsg("Could not check your files. Refresh the page and try again.");
        setIsUploading(false);
        return;
      }
      if (version !== sourceVersion.current) {
        setIsUploading(false);
        return;
      }
      const { report } = scan;
      const parts: string[] = [];
      if (report.skippedFiles.length > 0) {
        parts.push(`Excluded ${report.skippedFiles.length} sensitive file(s) (${report.skippedFiles.join(", ")})`);
      }
      if (report.redactedFiles.length > 0) {
        parts.push(`Redacted common secrets in ${report.redactedFiles.length} file(s)`);
      }
      setSecretWarningMsg(parts.length ? parts.join(" · ") : null);
      if (report.skippedFiles.length > 0 || report.redactedFiles.length > 0) {
        trackEvent("secrets_sanitized", {
          skipped_count: report.skippedFiles.length,
          redacted_count: report.redactedFiles.length,
        });
      }
      if (scan.sanitized.length === 0) {
        setPushErrorMsg("Every file was excluded. Choose a ZIP or folder with files you can push.");
        setIsUploading(false);
        return;
      }
      if (report.unscannedFiles.length > 0) {
        setPendingScan(scan);
        setIsUploading(false);
        return;
      }
    }

    const { sanitized: filesToUpload, report } = scan;
    try {
      const commit = await uploadToGitHub(
        owner,
        repo,
        filesToUpload,
        "Upload files via ZiptoGit",
        (status, current, total) => {
          setUploadStatusMsg(status);
          setUploadProgress({ current, total });
        }
      );
      setUploadSuccessUrl(`https://github.com/${selectedRepoFullId}`);
      setPushResult({
        repo: selectedRepoFullId,
        fileCount: filesToUpload.length,
        skipped: report.skippedFiles.length,
        redacted: report.redactedFiles.length,
        commitSha: typeof commit?.sha === "string" ? commit.sha.slice(0, 7) : undefined,
        commitUrl:
          typeof commit?.html_url === "string" && commit.html_url.startsWith("https://github.com/")
            ? commit.html_url
            : undefined,
      });
      setPendingScan(null);
      trackEvent("push_successful", { files_count: filesToUpload.length });
    } catch (err: any) {
      console.error("Upload error details:", err);
      const apiErrorMsg = err.response?.data?.message;
      setPushErrorMsg(apiErrorMsg ? `GitHub API Error: ${apiErrorMsg}` : (err.message || "An error occurred during upload."));
      trackEvent("push_failed", { error: apiErrorMsg || err.message });
    } finally {
      setIsUploading(false);
    }
  };

  // --- Manage (delete) existing repo files/folders --- //
  const managedRepo = view === "manage" && !isCreatingRepo ? selectedRepoFullId : "";
  const managedRepoRef = useRef("");
  useLayoutEffect(() => {
    managedRepoRef.current = managedRepo;
    setDeleteSuccessMsg(null);
    return () => { managedRepoRef.current = ""; };
  }, [managedRepo]);

  // The tree loads whenever the manage view is open for a repo (and again on
  // "Try again"). The cancelled flag drops a stale response if the repo or view
  // changes mid-request.
  useEffect(() => {
    if (view !== "manage" || !selectedRepoFullId || isCreatingRepo) return;
    let cancelled = false;
    setIsLoadingTree(true);
    setTreeErrorMsg(null);
    setSelectedDeletePaths(new Set());
    setShowDeleteRepoConfirm(false);
    setDeleteRepoConfirmText("");
    setDeleteRepoErrorMsg(null);
    const [owner, repo] = selectedRepoFullId.split("/");
    // Fetch the tree component while the file list is in flight.
    loadRepoFileTree().catch(() => {});
    fetchRepoTree(owner, repo, defaultBranchOf(selectedRepoFullId))
      .then(({ tree, truncated }) => {
        if (cancelled) return;
        setRepoTree(tree);
        setTreeTruncated(!!truncated);
      })
      .catch((err: any) => {
        if (cancelled) return;
        console.error(err);
        setTreeErrorMsg(err.message || "Failed to load repository files.");
        setRepoTree([]);
        setTreeTruncated(false);
      })
      .finally(() => { if (!cancelled) setIsLoadingTree(false); });
    return () => { cancelled = true; };
  }, [view, selectedRepoFullId, isCreatingRepo, treeReloadKey]);

  const handleDeleteSelected = async () => {
    if (isDeleting || !selectedRepoFullId || selectedDeletePaths.size === 0) return;
    const [owner, repo] = selectedRepoFullId.split("/");
    const pathsArray: string[] = Array.from(selectedDeletePaths);

    setDeletingFrom(selectedRepoFullId);
    setTreeErrorMsg(null);
    setDeleteSuccessMsg(null);
    try {
      await deleteRepoPaths(
        owner,
        repo,
        pathsArray,
        `Delete ${pathsArray.length} item(s) via ZiptoGit`,
        (status) => setDeleteStatusMsg(status)
      );
      trackEvent("repo_files_deleted", { count: pathsArray.length });
      if (managedRepoRef.current === selectedRepoFullId) {
        setDeleteSuccessMsg(`Deleted ${pathsArray.length} item(s) successfully.`);
        setSelectedDeletePaths(new Set());
        setIsLoadingTree(true);
        // Let the tree effect own the refresh, including cancellation on navigation.
        setTreeReloadKey((key) => key + 1);
      }
    } catch (err: any) {
      console.error("Delete error details:", err);
      if (managedRepoRef.current === selectedRepoFullId) {
        setTreeErrorMsg(err.message || "Failed to delete selected items.");
      }
      trackEvent("repo_files_delete_failed", { error: err.message });
    } finally {
      setDeletingFrom(null);
      setDeleteStatusMsg("");
    }
  };

  const canConfirmDeleteRepo = !!selectedRepoFullId
    && deleteRepoConfirmText === selectedRepoFullId
    && !isDeletingRepo
    && !isUploading
    && !isLoadingMoreRepos;

  const handleDeleteRepo = async () => {
    if (!canConfirmDeleteRepo || repoPageRequest.current) return;
    const [owner, repo] = selectedRepoFullId.split("/");

    setIsDeletingRepo(true);
    setDeleteRepoErrorMsg(null);
    try {
      await deleteRepository(owner, repo);
      trackEvent("repo_deleted");
      // Deleting an item can move an unseen repository onto the last loaded
      // page. Revisit that boundary on the next click and deduplicate by ID.
      setNextRepoPage((page) => page === null ? null : Math.max(1, page - 1));
      setRepos((prev) => prev.filter((entry) => entry.full_name !== selectedRepoFullId));
      setSelectedRepoFullId("");
      setShowDeleteRepoConfirm(false);
      setDeleteRepoConfirmText("");
      setRepoTree([]);
      setSelectedDeletePaths(new Set());
    } catch (err: any) {
      console.error("Delete repo error details:", err);
      setDeleteRepoErrorMsg(err.message || "Failed to delete repository.");
      trackEvent("repo_delete_failed", { error: err.message });
    } finally {
      setIsDeletingRepo(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Derived state for the three-step push flow
  // ---------------------------------------------------------------------------
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const repoReady = !!selectedRepoFullId && !isCreatingRepo;
  const filesReady = !!selectedSource && !isExtracting && extractedFiles.length > 0;
  const stepStatus = (n: 1 | 2): StepStatus => {
    const done = n === 1 ? repoReady : filesReady;
    if (done) return "done";
    const firstOpen = !repoReady ? 1 : !filesReady ? 2 : 0;
    return firstOpen === n ? "current" : "upcoming";
  };
  const viewTitle = VIEWS.find((v) => v.id === view)!.label;
  const pushPct =
    uploadProgress.total > 0 ? Math.min(100, Math.round((uploadProgress.current / uploadProgress.total) * 100)) : 0;

  // Why the main button is disabled, in words, so it is never a dead end.
  const pushBlocker = isUploading
    ? null
    : isCreatingRepo
      ? "Create the new repository first, or pick an existing one."
      : !selectedRepoFullId && !selectedSource
        ? "Select a repository and add your files to continue."
        : !selectedRepoFullId
          ? "Select a repository to continue."
          : !selectedSource
            ? "Add your files to continue."
            : isExtracting
              ? "Reading your files…"
              : extractedFiles.length === 0
                ? "No files found. Remove this and add a different ZIP or folder."
                : null;

  const clearSource = () => {
    sourceVersion.current++;
    setIsExtracting(false);
    setIsReadingFolder(false);
    clearPushResult();
    setSelectedSource(null);
    setExtractedFiles([]);
    setErrorMsg(null);
  };

  const errorAlert = (msg: string) => <Alert variant="error" className="mt-3">{msg}</Alert>;

  const avatar = (
    <div className="w-7 h-7 rounded-full bg-tint-3 flex items-center justify-center shrink-0 text-sm font-medium text-slate-600 dark:text-slate-300 uppercase overflow-hidden">
      {user?.avatar_url ? (
        <img src={avatarSrc(user.avatar_url)} alt="" width={AVATAR_PX} height={AVATAR_PX} decoding="async" className="w-full h-full object-cover" />
      ) : (
        user?.login?.charAt(0)
      )}
    </div>
  );

  // Avatar + username, identical in the desktop sidebar and the phone card.
  const userChip = (
    <>
      {avatar}
      <span className="flex-1 min-w-0 text-sm font-medium text-slate-600 dark:text-slate-300 truncate">{user?.login}</span>
    </>
  );

  // ---------------------------------------------------------------------------
  // Repository picker (select + inline "create new"), shared by both views
  // ---------------------------------------------------------------------------
  const repoOptions = useMemo(() => repos.map((repo) => (
    <option key={repo.id} value={repo.full_name}>{repo.full_name}</option>
  )), [repos]);

  const repoPicker = (
    <>
      <div className="relative">
        <select
          ref={repoSelectRef}
          id={repoSelectId}
          aria-labelledby={repoLabelId}
          value={isCreatingRepo ? CREATE_NEW_REPO_VALUE : (selectedRepoFullId || "")}
          onChange={(e) => handleRepoSelectChange(e.target.value)}
          className={`${FIELD} border border-field appearance-none cursor-pointer transition-colors dark:[color-scheme:dark]`}
          disabled={isUploading || isDeletingRepo}
        >
          <option value="" disabled>Choose a repository…</option>
          {repoOptions}
          <option value={CREATE_NEW_REPO_VALUE}>+ Create new repository</option>
        </select>
        <div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none text-muted">
          <ChevronDown className="w-4 h-4" />
        </div>
      </div>
      {nextRepoPage !== null && !isCreatingRepo && (
        <button
          type="button"
          onClick={loadMoreRepos}
          disabled={!canLoadMoreRepos}
          aria-controls={repoSelectId}
          aria-busy={isLoadingMoreRepos}
          className={`${BTN} ${BTN_SECONDARY} mt-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          {isLoadingMoreRepos ? "Loading repositories…" : repoListError ? "Retry loading repositories" : "Load more repositories"}
        </button>
      )}
      {repoListError && <Alert variant="error" className="mt-2">{repoListError}</Alert>}

      {isCreatingRepo && (
        <div className="mt-3 border border-edge rounded-panel p-4 bg-tint-1 transition-colors">
          <label htmlFor={newRepoNameId} className="text-sm font-medium text-muted mb-2 block">
            New repository name
          </label>
          <input
            id={newRepoNameId}
            type="text"
            aria-invalid={createRepoErrorMsg ? true : undefined}
            value={newRepoName}
            onChange={(e) => setNewRepoName(e.target.value)}
            disabled={isSubmittingNewRepo}
            placeholder="ziptogit.in_new1"
            className={`${FIELD} border border-field font-mono placeholder:text-muted mb-3`}
          />

          <div role="group" aria-label="Visibility" className="flex items-center gap-2 mb-4">
            <button
              type="button"
              onClick={() => setNewRepoIsPrivate(false)}
              aria-pressed={!newRepoIsPrivate}
              disabled={isSubmittingNewRepo}
              className={`${BTN} text-sm border transition-colors ${
                !newRepoIsPrivate
                  ? "bg-primary text-on-primary border-primary"
                  : "bg-input text-muted border-field hover:text-slate-700 dark:hover:text-slate-200"
              }`}
            >
              <Globe className="w-4 h-4" /> Public
            </button>
            <button
              type="button"
              onClick={() => setNewRepoIsPrivate(true)}
              aria-pressed={newRepoIsPrivate}
              disabled={isSubmittingNewRepo}
              className={`${BTN} text-sm border transition-colors ${
                newRepoIsPrivate
                  ? "bg-primary text-on-primary border-primary"
                  : "bg-input text-muted border-field hover:text-slate-700 dark:hover:text-slate-200"
              }`}
            >
              <Lock className="w-4 h-4" /> Private
            </button>
          </div>

          {createRepoErrorMsg && <Alert variant="error" className="mb-3">{createRepoErrorMsg}</Alert>}

          <div className="flex gap-2">
            <CancelButton onClick={handleCancelCreateRepo} disabled={isSubmittingNewRepo} />
            <button
              type="button"
              onClick={handleCreateRepo}
              disabled={isSubmittingNewRepo}
              className={`${BTN} flex-1 text-sm ${isSubmittingNewRepo ? "bg-primary text-on-primary cursor-progress" : BTN_PRIMARY}`}
            >
              {isSubmittingNewRepo ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> Creating…
                </>
              ) : (
                <>
                  <Plus className="w-4 h-4" /> Create repository
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </>
  );

  // ---------------------------------------------------------------------------
  // PUSH view: Step 1 repository, Step 2 files, Step 3 push
  // ---------------------------------------------------------------------------
  const dropZone = (
    <div
      onClick={(event) => {
        // A programmatic click on either hidden file input bubbles here too.
        if (isReadingFolder || event.target instanceof HTMLInputElement) return;
        warmZipExtractor();
        fileInputRef.current?.click();
      }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`border border-dashed rounded-panel p-6 sm:p-8 flex flex-col items-center justify-center text-center transition-colors ${
        isReadingFolder ? "cursor-wait" : "cursor-pointer"
      } ${
        isDraggingFile
          ? "border-primary bg-tint-2"
          : "border-field hover:border-muted hover:bg-tint-1"
      }`}
    >
      <input type="file" accept=".zip,application/zip" className="hidden" ref={fileInputRef} onChange={handleFileChange} />
      {/* Folder picking relies on the non-standard `webkitdirectory` attribute,
          which iOS Safari doesn't support and Android's file browser exposes
          inconsistently, so it is desktop-only; phones always have the ZIP path. */}
      <input
        type="file"
        className="hidden"
        ref={folderInputRef}
        onChange={handleFolderChange}
        // @ts-ignore - non-standard but widely supported attributes
        webkitdirectory=""
        directory=""
        multiple
      />
      <div className="w-12 h-12 bg-tint-2 border border-edge rounded-full flex items-center justify-center mb-3 text-slate-600 dark:text-slate-300">
        {isReadingFolder ? <Loader2 className="w-5 h-5 animate-spin" /> : <Upload className="w-5 h-5" />}
      </div>
      {isReadingFolder ? (
        <>
          <p className={`${T.prompt} mb-1`}>Reading folder…</p>
          <p className="text-muted text-sm">This can take a moment for larger projects</p>
        </>
      ) : (
        <>
          <p className={`${T.prompt} mb-1`}>{isDesktop ? "Drop a ZIP or folder here" : "Add your ZIP file"}</p>
          <p className="text-muted text-sm mb-4">
            {isDesktop ? "ZIP archive or project folder, up to 50MB" : "ZIP archive, up to 50MB"}
          </p>
          {/* The whole zone is clickable; this button is the visible, keyboard-reachable
              way in. Its click bubbles up to the zone, so no handler of its own. */}
          <button type="button" className={`${BTN} ${BTN_SECONDARY} text-sm`}>
            <FileArchive className="w-4 h-4" /> Choose ZIP file
          </button>
          {isDesktop && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                folderInputRef.current?.click();
              }}
              className="mt-2 h-11 px-4 inline-flex items-center gap-2 text-sm text-muted hover:text-ink dark:hover:text-white hover:underline underline-offset-4 transition-colors"
            >
              <Folder className="w-4 h-4" /> or select a folder
            </button>
          )}
        </>
      )}
    </div>
  );

  const selectedFileCard = selectedSource && (
    <div className="border border-edge rounded-panel p-4 bg-tint-1 flex items-center justify-between transition-colors">
      <div className="flex items-center gap-3 overflow-hidden">
        <div className="w-10 h-10 rounded-control bg-tint-2 text-slate-600 dark:text-slate-300 flex items-center justify-center shrink-0">
          {selectedSource.kind === "folder" ? <Folder className="w-5 h-5" /> : <FileArchive className="w-5 h-5" />}
        </div>
        <div className="overflow-hidden">
          <p className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">{selectedSource.name}</p>
          <p className="text-sm text-muted truncate">
            {isExtracting
              ? `Reading ${extractingName || "files"}…`
              : `${extractedFiles.length} file${extractedFiles.length === 1 ? "" : "s"} ready`}
          </p>
        </div>
      </div>
      <button
        type="button"
        aria-label="Remove selected files"
        disabled={isUploading}
        onClick={clearSource}
        className="h-11 w-11 -mr-3 inline-flex items-center justify-center text-muted hover:text-slate-700 dark:hover:text-slate-200 hover:bg-tint-2 rounded-control transition-colors shrink-0 disabled:opacity-50"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );

  const pushArea = pushResult ? (
    <div role="status" className="rounded-panel border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/10 p-4">
      <div className="flex items-start gap-3">
        <CheckCircle className="w-5 h-5 mt-0.5 text-emerald-700 dark:text-emerald-400 shrink-0" />
        <div className="min-w-0">
          <p className="text-base font-medium text-emerald-900 dark:text-emerald-200 break-words">
            Pushed {pushResult.fileCount} file{pushResult.fileCount === 1 ? "" : "s"} to {pushResult.repo}
          </p>
          <p className="text-sm text-emerald-800 dark:text-emerald-300 mt-0.5">
            {[
              pushResult.commitSha ? `Commit ${pushResult.commitSha}` : null,
              pushResult.skipped > 0 ? `${pushResult.skipped} sensitive file${pushResult.skipped === 1 ? "" : "s"} excluded` : null,
              pushResult.redacted > 0 ? `${pushResult.redacted} file${pushResult.redacted === 1 ? "" : "s"} redacted` : null,
            ].filter(Boolean).join(" · ") || "Your files are on GitHub."}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 mt-4">
        <a
          href={uploadSuccessUrl || `https://github.com/${pushResult.repo}`}
          target="_blank"
          rel="noopener noreferrer"
          className={`${BTN} text-sm bg-primary text-on-primary hover:bg-primary-hover transition-colors`}
        >
          View on GitHub <ExternalLink className="w-4 h-4" />
        </a>
        {pushResult.commitUrl && (
          <a
            href={pushResult.commitUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={`${BTN} ${BTN_SECONDARY} text-sm`}
          >
            View commit <ExternalLink className="w-4 h-4" />
          </a>
        )}
        <button type="button" onClick={clearSource} className={`${BTN} ${BTN_SECONDARY} text-sm`}>
          Push more files
        </button>
      </div>
    </div>
  ) : (
    <>
      {pendingScan && (
        <Alert variant="warning" className="mb-3">
          <p>These files exceeded the scan limit and will be pushed without a secret check. Review them before continuing.</p>
          <ul className="mt-2 max-h-32 overflow-auto list-disc pl-4 break-all" aria-label="Files above the scan limit">
            {pendingScan.report.unscannedFiles.map((file) => <li key={file}>{file}</li>)}
          </ul>
        </Alert>
      )}
      <button
        type="button"
        onClick={handleUpload}
        disabled={isUploading || isExtracting || !selectedSource || extractedFiles.length === 0 || !selectedRepoFullId || isCreatingRepo}
        aria-describedby={pushBlocker ? "push-hint" : undefined}
        className={`${BTN} w-full text-base ${
          isUploading ? "bg-primary text-on-primary cursor-progress" : BTN_CTA
        }`}
      >
        {isUploading ? (
          <>
            <Loader2 className="w-5 h-5 animate-spin" /> Pushing…
          </>
        ) : (
          pendingScan ? "Push without scanning these files" : "Push files"
        )}
      </button>
      {isUploading && (
        <div className="mt-4" role="progressbar" aria-label="Upload progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pushPct}>
          <div className="h-2 rounded-full bg-tint-3 overflow-hidden">
            <div className="h-full rounded-full bg-primary transition-[width] duration-200" style={{ width: `${pushPct}%` }} />
          </div>
          <p className="mt-2 text-sm text-muted flex justify-between gap-3">
            <span className="truncate">{uploadStatusMsg || "Starting…"}</span>
            <span className="tabular-nums">{pushPct}%</span>
          </p>
        </div>
      )}
      {pushBlocker && (
        <p id="push-hint" className="mt-3 text-sm text-center text-muted">
          {pushBlocker}
        </p>
      )}
      {pushErrorMsg && errorAlert(pushErrorMsg)}
    </>
  );

  const pushView = (
    <>
      <section className="mb-8" aria-labelledby={repoLabelId}>
        <StepHeader n={1} title="Repository" status={stepStatus(1)} titleId={repoLabelId} />
        {repoPicker}
      </section>

      <section className="mb-8" aria-labelledby={filesLabelId}>
        <StepHeader n={2} title="Files" status={stepStatus(2)} titleId={filesLabelId} />
        {!selectedSource ? dropZone : selectedFileCard}
        {errorMsg && errorAlert(errorMsg)}
      </section>

      {/* No third step header: the button is the destination of steps 1 and 2, and
          it names itself. */}
      <section aria-label="Push files">
        {pushArea}
        {secretWarningMsg && <Alert variant="warning" className="mt-3">{secretWarningMsg}</Alert>}
        {!pushResult && (
          <p className="mt-3 text-sm flex items-start gap-2 text-muted">
            <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0 text-emerald-700 dark:text-emerald-400" />
            <span>{SECRET_SCAN_NOTE}</span>
          </p>
        )}
      </section>
    </>
  );

  // ---------------------------------------------------------------------------
  // MANAGE view: browse/delete files, plus the one and only "delete repository"
  // ---------------------------------------------------------------------------
  const manageView = (
    <>
      <section className="mb-8">
        {/* Same heading as Push step 1 (T.title, 16/600, mb-3), minus the number:
            these two views are not a sequence. */}
        <h2 className={`${T.title} text-slate-900 dark:text-slate-100 mb-3`}>
          <label id={repoLabelId} htmlFor={repoSelectId}>Repository</label>
        </h2>
        {repoPicker}
      </section>

      {!repoReady ? (
        <p className="text-sm text-muted py-8 text-center">
          {isCreatingRepo ? "Create the repository to manage its files." : "Select a repository to see its files."}
        </p>
      ) : (
        <>
          <section aria-labelledby="files-title">
            <h2 id="files-title" className={`${T.title} text-slate-900 dark:text-slate-100 mb-3 break-words`}>
              Files in {selectedRepoFullId}
            </h2>
            <div className="border border-edge rounded-panel p-4 bg-tint-1 transition-colors">
              {isLoadingTree ? (
                <div className="flex items-center gap-2 text-sm text-muted py-4 justify-center">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading repository files…
                </div>
              ) : treeErrorMsg ? (
                <div className="py-2">
                  <Alert variant="error" className="mb-3">{treeErrorMsg}</Alert>
                  <button
                    type="button"
                    onClick={() => setTreeReloadKey((k) => k + 1)}
                    className={`${BTN} ${BTN_SECONDARY} text-sm`}
                  >
                    Try again
                  </button>
                </div>
              ) : repoTree.length === 0 ? (
                <p className="text-sm text-muted py-2 text-center">This repository has no files yet.</p>
              ) : (
                <>
                  <p className="text-sm text-muted mb-2">
                    Check files or folders to mark them for deletion.
                  </p>
                  {treeTruncated && (
                    <Alert variant="warning" className="mb-3">
                      This repository is too large for GitHub to list completely, so some files are not shown here.
                      Deleting a folder still removes everything inside it.
                    </Alert>
                  )}
                  <RepoFileTreeErrorBoundary key={selectedRepoFullId}>
                    <Suspense
                      fallback={
                        <div className="flex items-center justify-center py-6 mb-3" role="status">
                          <Loader2 className="w-5 h-5 text-muted animate-spin" />
                          <span className="sr-only">Loading files…</span>
                        </div>
                      }
                    >
                      <RepoFileTree entries={repoTree} selected={selectedDeletePaths} onChange={setSelectedDeletePaths} />
                    </Suspense>
                  </RepoFileTreeErrorBoundary>
                  {deleteSuccessMsg && (
                    <Alert variant="success" className="mb-3">{deleteSuccessMsg}</Alert>
                  )}
                  <button
                    type="button"
                    onClick={handleDeleteSelected}
                    disabled={selectedDeletePaths.size === 0 || isDeleting}
                    className={`${BTN} w-full text-sm ${
                      isDeleting
                        ? "border border-red-500 dark:border-red-400/60 text-red-700 dark:text-red-300 cursor-progress"
                        : BTN_DANGER_OUTLINE
                    }`}
                  >
                    {isDeleting ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" /> {deletingFrom === selectedRepoFullId ? deleteStatusMsg || "Deleting…" : `Finishing deletion in ${deletingFrom}…`}
                      </>
                    ) : (
                      <>
                        <Trash2 className="w-4 h-4" />
                        Delete {selectedDeletePaths.size > 0 ? `${selectedDeletePaths.size} selected` : "selected"}
                      </>
                    )}
                  </button>
                </>
              )}
            </div>
          </section>

          {!isLoadingTree && (
            <section aria-labelledby="danger-title" className="mt-8 rounded-panel border border-red-500 dark:border-red-400/60 p-4">
              <h2 id="danger-title" className={`${T.title} text-red-700 dark:text-red-400 mb-1`}>
                Danger zone
              </h2>
              {!showDeleteRepoConfirm ? (
                <>
                  <p className="text-sm text-muted mb-3">
                    Permanently delete <span className="font-medium break-all text-slate-900 dark:text-slate-100">{selectedRepoFullId}</span> from GitHub. This can’t be undone.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setShowDeleteRepoConfirm(true);
                      setDeleteRepoConfirmText("");
                      setDeleteRepoErrorMsg(null);
                    }}
                    className={`${BTN} text-sm ${BTN_DANGER}`}
                  >
                    Delete repository…
                  </button>
                </>
              ) : (
                <div>
                  {/* One message, in the danger zone's own red frame. (There used to be
                      a red error Alert saying "can't be undone" and then the
                      instruction: the same warning twice, in the failure colour.
                      Alert error is now only for an actual failure, below.) */}
                  <p id={deleteConfirmHintId} className="text-sm text-muted mb-3">
                    This permanently deletes the repository and can’t be undone. Type <span className="font-mono break-all text-slate-900 dark:text-slate-100">{selectedRepoFullId}</span> to confirm.
                  </p>
                  <input
                    type="text"
                    aria-label="Full repository name to confirm deletion"
                    aria-describedby={deleteConfirmHintId}
                    value={deleteRepoConfirmText}
                    onChange={(e) => setDeleteRepoConfirmText(e.target.value)}
                    placeholder={selectedRepoFullId}
                    className={`${FIELD} border border-red-500 dark:border-red-400 font-mono placeholder:text-muted mb-3`}
                    disabled={isDeletingRepo}
                  />
                  {deleteRepoErrorMsg && <Alert variant="error" className="mb-3">{deleteRepoErrorMsg}</Alert>}
                  <div className="flex gap-2">
                    <CancelButton
                      onClick={() => {
                        setShowDeleteRepoConfirm(false);
                        setDeleteRepoConfirmText("");
                        setDeleteRepoErrorMsg(null);
                      }}
                      disabled={isDeletingRepo}
                    />
                    <button
                      type="button"
                      onClick={handleDeleteRepo}
                      disabled={!canConfirmDeleteRepo}
                      className={`${BTN} flex-1 text-sm ${
                        isDeletingRepo ? "bg-red-700 text-white cursor-progress" : BTN_DANGER
                      }`}
                    >
                      {isDeletingRepo ? (
                        <><Loader2 className="w-4 h-4 animate-spin" /> Deleting…</>
                      ) : (
                        "Delete forever"
                      )}
                    </button>
                  </div>
                </div>
              )}
            </section>
          )}
        </>
      )}
    </>
  );

  const activeView = view === "push" ? pushView : manageView;
  const logoutLabel = isLoggingOut ? "Disconnecting…" : logoutFailed ? "Retry disconnect" : "Disconnect";
  const logoutAlert = logoutFailed && (
    <Alert variant="error" className="mb-3">Couldn’t confirm sign-out. Try again.</Alert>
  );

  const logoutButton = (
    <button
      type="button"
      onClick={logout}
      disabled={isLoggingOut}
      aria-label={isDesktop && !isLoggingOut && !logoutFailed ? "Disconnect GitHub account" : logoutLabel}
      title={isDesktop ? logoutLabel : undefined}
      className={`h-11 -mr-3 inline-flex items-center text-muted hover:text-slate-900 dark:hover:text-white transition-colors disabled:opacity-60 ${
        isDesktop ? "w-11 justify-center hover:bg-tint-3 rounded-control shrink-0" : "px-3 gap-2 text-sm"
      }`}
    >
      {isLoggingOut
        ? <Loader2 aria-hidden="true" className="w-4 h-4 animate-spin" />
        : <LogOut aria-hidden="true" className="w-4 h-4" />}
      {!isDesktop && logoutLabel}
    </button>
  );

  if (isDesktop) {
    return (
      <div className={`flex w-full max-w-app min-h-140 overflow-hidden transition-colors duration-200 ${CARD_EDGE}`}>
        {/* Sidebar: navigation between the two views, plus the account */}
        <aside className="w-52 shrink-0 bg-tint-1 border-r border-edge-subtle p-4 flex flex-col transition-colors">
          <nav aria-label="Dashboard" className="flex flex-col gap-1">
            {VIEWS.map(({ id, label, icon }) => (
              <SidebarItem key={id} active={view === id} icon={icon} onClick={() => setView(id)}>
                {label}
              </SidebarItem>
            ))}
          </nav>

          <div className="flex-1" />

          <div className="mt-2 pt-3 border-t border-edge-subtle">
            {logoutAlert}
            <div className="flex items-center gap-3 px-1">
              {userChip}
              {logoutButton}
            </div>
          </div>
        </aside>

        {/* Main panel */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="p-8">
            <h1 className={`${T.h1} text-ink dark:text-white mb-6`}>{viewTitle}</h1>
            {activeView}
          </div>
        </div>
      </div>
    );
  }

  // ===========================================================================
  // MOBILE / TABLET: one column, segmented view switch, account row at the end
  // ===========================================================================
  return (
    <div className={`w-full max-w-app-sm sm:max-w-content overflow-hidden transition-colors duration-200 ${CARD_EDGE}`}>
      <div className="p-6 bg-surface">
        {/* The switch below already names the active view, so the h1 is
            for screen readers only: no banner repeating it. */}
        <h1 className="sr-only">{viewTitle}</h1>
        <div role="group" aria-label="Section" className="grid grid-cols-2 gap-1 p-1 rounded-control bg-tint-2 mb-6">
          {VIEWS.map(({ id: v, label }) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={`h-11 rounded-control text-sm font-medium transition-colors ${
                view === v
                  ? "bg-lift text-ink dark:text-white elevation-control"
                  : "text-muted hover:text-slate-900 dark:hover:text-white"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {activeView}

        <div className="mt-8 pt-4 border-t border-edge-subtle">
          {logoutAlert}
          <div className="flex items-center gap-3">
            {userChip}
            {logoutButton}
          </div>
        </div>
      </div>
    </div>
  );
}
