import type { RepoTreeEntry } from "./github";

export interface TreeNode {
  name: string;
  path: string;
  type: "blob" | "tree";
  children: TreeNode[];
}

/**
 * Turns a flat list of repo tree entries (as returned by the GitHub API) into
 * a nested folder/file structure for rendering as a checkbox tree.
 */
export function buildTree(entries: RepoTreeEntry[]): TreeNode[] {
  const root: TreeNode[] = [];
  const nodeByPath = new Map<string, TreeNode>();

  // Sort so parent folders are processed before their children.
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));

  for (const entry of sorted) {
    const parts = entry.path.split("/");
    const name = parts[parts.length - 1];
    const parentPath = parts.slice(0, -1).join("/");

    const node: TreeNode = { name, path: entry.path, type: entry.type, children: [] };
    nodeByPath.set(entry.path, node);

    if (parentPath && nodeByPath.has(parentPath)) {
      nodeByPath.get(parentPath)!.children.push(node);
    } else {
      root.push(node);
    }
  }

  return root;
}

/**
 * True if `path` is covered by the current selection — either it's itself
 * selected, or an ancestor folder is selected (which implicitly covers
 * everything nested inside it). Used to render the "already covered,
 * disabled" state on child checkboxes and must stay behavioraly identical
 * to the server's deletion matching (see server/githubService.ts#isPathRemoved).
 */
export function isPathCovered(path: string, selected: Set<string>): boolean {
  if (selected.has(path)) return true;
  const parts = path.split("/");
  for (let i = parts.length - 1; i > 0; i--) {
    if (selected.has(parts.slice(0, i).join("/"))) return true;
  }
  return false;
}

/**
 * Toggles `path` in the selection set. Selecting a folder drops any
 * already-selected descendants, since the folder now covers them.
 */
export function toggleSelection(current: Set<string>, path: string): Set<string> {
  const next = new Set(current);
  if (next.has(path)) {
    next.delete(path);
  } else {
    for (const p of Array.from(next)) {
      if (p.startsWith(path + "/")) next.delete(p);
    }
    next.add(path);
  }
  return next;
}
