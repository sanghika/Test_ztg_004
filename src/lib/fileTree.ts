import type { RepoTreeEntry } from "./github";

export interface TreeNode {
  name: string;
  path: string;
  type: "blob" | "tree";
  children: TreeNode[];
}

// One collator for the whole module. `a.localeCompare(b)` builds (or looks up)
// a collator on every call, which is what made sorting thousands of names slow;
// a shared Intl.Collator gives the same order for a fraction of the cost.
const collator = new Intl.Collator();

/** Folders before files, then by name. The order every folder is shown in. */
export const compareNodes = (a: TreeNode, b: TreeNode): number =>
  a.type !== b.type ? (a.type === "tree" ? -1 : 1) : collator.compare(a.name, b.name);

/**
 * Turns a flat list of repo tree entries (as returned by the GitHub API) into
 * a nested folder/file structure for rendering as a checkbox tree.
 *
 * Every sibling list comes back already sorted (folders first, then by name),
 * so rendering never has to sort. Entries may arrive in any order: nodes are all
 * created first and then attached to their parents, which needs no sort of the
 * whole path list. An entry whose parent is missing goes to the top level.
 */
export function buildTree(entries: RepoTreeEntry[]): TreeNode[] {
  const root: TreeNode[] = [];
  const nodeByPath = new Map<string, TreeNode>();

  for (const entry of entries) {
    const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
    nodeByPath.set(entry.path, { name, path: entry.path, type: entry.type, children: [] });
  }

  for (const node of nodeByPath.values()) {
    const slash = node.path.lastIndexOf("/");
    const parent = slash > 0 ? nodeByPath.get(node.path.slice(0, slash)) : undefined;
    (parent ? parent.children : root).push(node);
  }

  root.sort(compareNodes);
  for (const node of nodeByPath.values()) {
    if (node.children.length > 1) node.children.sort(compareNodes);
  }
  return root;
}

export interface FlatRow {
  node: TreeNode;
  depth: number;
}

/**
 * The rows that are currently shown, top to bottom: every node except those
 * inside a collapsed folder. This flat list is what gets windowed.
 */
export function flattenTree(nodes: TreeNode[], collapsed: ReadonlySet<string>): FlatRow[] {
  const rows: FlatRow[] = [];
  const walk = (list: TreeNode[], depth: number) => {
    for (const node of list) {
      rows.push({ node, depth });
      if (node.type === "tree" && node.children.length > 0 && !collapsed.has(node.path)) {
        walk(node.children, depth + 1);
      }
    }
  };
  walk(nodes, 0);
  return rows;
}

/**
 * Which rows to render for a scroll position: those in view plus `overscan`
 * above and below, so quick scrolling does not show blank space. `end` is
 * exclusive. Every row is `rowHeight` tall.
 */
export function visibleRange(
  firstVisibleRow: number,
  viewportHeight: number,
  rowHeight: number,
  rowCount: number,
  overscan = 8
): { start: number; end: number } {
  const first = Math.min(Math.max(0, firstVisibleRow), rowCount);
  const inView = Math.ceil(viewportHeight / rowHeight) + 1;
  return {
    start: Math.max(0, first - overscan),
    end: Math.min(rowCount, first + inView + overscan),
  };
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
