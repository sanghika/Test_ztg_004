import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown, ChevronRight, Folder, FolderOpen, File as FileIcon } from "lucide-react";
import type { RepoTreeEntry } from "../lib/github";
import { buildTree, flattenTree, isPathCovered, toggleSelection, visibleRange } from "../lib/fileTree";
import type { TreeNode } from "../lib/fileTree";

// Touch targets: every row is 44px tall on touch screens and 32px with a mouse
// (pointer-fine), so a desktop panel shows 12 rows instead of 8. The windowing
// below needs the height in pixels, so it follows the same media query the row
// classes use (Tailwind's `pointer-fine:` is `@media (pointer: fine)`).
const FINE_POINTER = "(pointer: fine)";
const ROW_HEIGHT_TOUCH = 44;
const ROW_HEIGHT_FINE = 32;
// Matches `max-h-96` on the scroll box, used until the real height is measured.
const DEFAULT_VIEWPORT = 384;
// Rows rendered above and below the visible ones, so fast scrolling stays filled.
const OVERSCAN = 8;

const subscribeFinePointer = (onChange: () => void) => {
  const mq = window.matchMedia(FINE_POINTER);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
};
const getFinePointer = () => window.matchMedia(FINE_POINTER).matches;
const getFinePointerOnServer = () => true;

interface RowProps {
  node: TreeNode;
  depth: number;
  covered: boolean;
  explicitlySelected: boolean;
  collapsed: boolean;
  position: number;
  setSize: number;
  onToggle: (path: string) => void;
  onToggleCollapse: (path: string) => void;
}

// Everything a row needs is a primitive or a stable callback, so a row is
// re-rendered only when ITS OWN state changes — not when some other row is
// checked or a folder elsewhere is collapsed.
const Row = memo(function Row({
  node,
  depth,
  covered,
  explicitlySelected,
  collapsed,
  position,
  setSize,
  onToggle,
  onToggleCollapse,
}: RowProps) {
  const checkboxDisabled = covered && !explicitlySelected;
  const guides = [];
  // One guide line per ancestor level, under that ancestor's chevron centre.
  for (let level = 1; level <= depth; level++) {
    guides.push(
      <span
        key={level}
        aria-hidden="true"
        className="absolute inset-y-0 w-px bg-edge-subtle pointer-events-none"
        style={{ left: `calc(var(--ztg-step) * ${level - 1} + var(--ztg-ml))` }}
      />
    );
  }

  // The chevron is a 44x44 (32x32) button; the checkbox, icon and name sit
  // inside ONE label, so the whole rest of the row toggles the checkbox (the
  // 16px box itself is never the thing you have to hit).
  return (
    <div
      role="listitem"
      aria-posinset={position}
      aria-setsize={setSize}
      aria-level={depth + 1}
      className="relative flex items-center text-sm h-11 pointer-fine:h-8"
      style={{ paddingLeft: `calc(var(--ztg-step) * ${depth})` }}
    >
      {guides}
      {node.type === "tree" ? (
        <button
          type="button"
          onClick={() => onToggleCollapse(node.path)}
          aria-label={collapsed ? `Expand ${node.name} folder` : `Collapse ${node.name} folder`}
          aria-expanded={!collapsed}
          className="h-11 w-11 pointer-fine:h-8 pointer-fine:w-8 inline-flex items-center justify-center rounded-control text-muted hover:text-slate-700 dark:hover:text-slate-200 hover:bg-tint-2 shrink-0"
        >
          {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
      ) : (
        <span className="w-11 pointer-fine:w-8 shrink-0" />
      )}
      <label
        className={`flex flex-1 items-center gap-3 h-full min-w-0 ${
          checkboxDisabled ? "cursor-not-allowed" : "cursor-pointer"
        }`}
      >
        <input
          type="checkbox"
          checked={covered}
          disabled={checkboxDisabled}
          onChange={() => onToggle(node.path)}
          className="w-4 h-4 shrink-0 cursor-pointer disabled:cursor-not-allowed accent-primary"
        />
        {node.type === "tree" ? (
          collapsed
            ? <Folder className="w-4 h-4 text-muted shrink-0" />
            : <FolderOpen className="w-4 h-4 text-muted shrink-0" />
        ) : (
          <FileIcon className="w-4 h-4 text-muted shrink-0" />
        )}
        <span className={`truncate font-mono ${covered ? "text-red-700 dark:text-red-400 line-through" : "text-slate-700 dark:text-slate-300"}`}>
          {node.name}
        </span>
      </label>
    </div>
  );
});

// The Manage files tree. Loaded on demand (React.lazy in App.tsx) because it is
// only needed once a repository's files are listed, and it owns everything that
// only the tree uses: building the nested structure, the selection rules, and
// the scrolling box.
//
// Only the rows in (and just around) the scroll box are in the DOM, so a
// repository with 5,000 files costs about the same to show as one with 50.
// The nested structure is built once per load (buildTree also sorts, once), the
// list of shown rows only changes when a folder is collapsed, and toggling a
// checkbox re-renders just the handful of rows whose state changed.
export default function RepoFileTree({
  entries,
  selected,
  onChange,
}: {
  entries: RepoTreeEntry[];
  selected: Set<string>;
  /** Takes an updater, like a React state setter, so the callback below never changes. */
  onChange: (update: (prev: Set<string>) => Set<string>) => void;
}) {
  const nodes = useMemo(() => buildTree(entries), [entries]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const rows = useMemo(() => flattenTree(nodes, collapsed), [nodes, collapsed]);

  const onToggle = useCallback((path: string) => onChange((prev) => toggleSelection(prev, path)), [onChange]);
  const onToggleCollapse = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }, []);

  const finePointer = useSyncExternalStore(subscribeFinePointer, getFinePointer, getFinePointerOnServer);
  const rowHeight = finePointer ? ROW_HEIGHT_FINE : ROW_HEIGHT_TOUCH;

  // Only the index of the first visible row is state, so scrolling re-renders
  // when a new row reaches the top and not on every pixel.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [firstRow, setFirstRow] = useState(0);
  const [viewport, setViewport] = useState(DEFAULT_VIEWPORT);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) setFirstRow(Math.floor(el.scrollTop / rowHeight));
  }, [rowHeight]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewport(el.clientHeight || DEFAULT_VIEWPORT);
    setFirstRow(Math.floor(el.scrollTop / rowHeight));
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setViewport(el.clientHeight || DEFAULT_VIEWPORT));
    observer.observe(el);
    return () => observer.disconnect();
  }, [rowHeight]);

  const { start, end } = visibleRange(firstRow, viewport, rowHeight, rows.length, OVERSCAN);

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      // The guide line sits under the parent's chevron centre: --ztg-ml is the
      // indent of a level (20px on touch, 16px with a mouse) and --ztg-step is
      // that plus the 1px line and 8px of padding, i.e. how far each level moves in.
      className="max-h-96 overflow-y-auto custom-scrollbar p-1 mb-3 [--ztg-ml:1.25rem] [--ztg-step:1.8125rem] pointer-fine:[--ztg-ml:1rem] pointer-fine:[--ztg-step:1.5625rem]"
    >
      <div role="list" aria-label="Repository files" style={{ height: rows.length * rowHeight, position: "relative" }}>
        <div style={{ transform: `translateY(${start * rowHeight}px)` }}>
          {rows.slice(start, end).map(({ node, depth }, i) => (
            <Row
              key={node.path}
              node={node}
              depth={depth}
              covered={isPathCovered(node.path, selected)}
              explicitlySelected={selected.has(node.path)}
              collapsed={collapsed.has(node.path)}
              position={start + i + 1}
              setSize={rows.length}
              onToggle={onToggle}
              onToggleCollapse={onToggleCollapse}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
