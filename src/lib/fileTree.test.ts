import { describe, it, expect } from "vitest";
import { buildTree, flattenTree, isPathCovered, toggleSelection, visibleRange } from "./fileTree";
import type { RepoTreeEntry } from "./github";

const entries: RepoTreeEntry[] = [
  { path: "README.md", type: "blob", sha: "1" },
  { path: "src", type: "tree", sha: "2" },
  { path: "src/App.tsx", type: "blob", sha: "3" },
  { path: "src/lib", type: "tree", sha: "4" },
  { path: "src/lib/github.ts", type: "blob", sha: "5" },
  { path: "public", type: "tree", sha: "6" },
  { path: "public/logo.png", type: "blob", sha: "7" },
];

describe("buildTree", () => {
  it("nests entries under their parent folders", () => {
    const tree = buildTree(entries);
    const names = tree.map((n) => n.name).sort();
    expect(names).toEqual(["README.md", "public", "src"]);

    const srcNode = tree.find((n) => n.name === "src")!;
    expect(srcNode.type).toBe("tree");
    expect(srcNode.children.map((c) => c.name).sort()).toEqual(["App.tsx", "lib"]);

    const libNode = srcNode.children.find((c) => c.name === "lib")!;
    expect(libNode.children.map((c) => c.name)).toEqual(["github.ts"]);
  });

  it("handles an empty entry list", () => {
    expect(buildTree([])).toEqual([]);
  });

  it("handles deeply nested paths regardless of input order", () => {
    const shuffled: RepoTreeEntry[] = [
      { path: "a/b/c/d.txt", type: "blob", sha: "1" },
      { path: "a/b/c", type: "tree", sha: "2" },
      { path: "a/b", type: "tree", sha: "3" },
      { path: "a", type: "tree", sha: "4" },
    ];
    const tree = buildTree(shuffled);
    expect(tree.length).toBe(1);
    expect(tree[0].name).toBe("a");
    expect(tree[0].children[0].name).toBe("b");
    expect(tree[0].children[0].children[0].name).toBe("c");
    expect(tree[0].children[0].children[0].children[0].name).toBe("d.txt");
  });
});

describe("isPathCovered", () => {
  it("is true for an exactly selected path", () => {
    const selected = new Set(["README.md"]);
    expect(isPathCovered("README.md", selected)).toBe(true);
  });

  it("is true for a file nested under a selected folder", () => {
    const selected = new Set(["src"]);
    expect(isPathCovered("src/App.tsx", selected)).toBe(true);
    expect(isPathCovered("src/lib/github.ts", selected)).toBe(true);
  });

  it("is false for a path outside the selected folder", () => {
    const selected = new Set(["src"]);
    expect(isPathCovered("public/logo.png", selected)).toBe(false);
    expect(isPathCovered("README.md", selected)).toBe(false);
  });

  it("does not treat a similarly-prefixed sibling as covered (e.g. 'src' vs 'src-old')", () => {
    const selected = new Set(["src"]);
    expect(isPathCovered("src-old/file.ts", selected)).toBe(false);
  });
});

describe("toggleSelection", () => {
  it("adds a path not yet selected", () => {
    const result = toggleSelection(new Set(), "README.md");
    expect(result.has("README.md")).toBe(true);
  });

  it("removes a path that is already selected", () => {
    const result = toggleSelection(new Set(["README.md"]), "README.md");
    expect(result.has("README.md")).toBe(false);
  });

  it("selecting a folder drops already-selected descendants (folder now covers them)", () => {
    const start = new Set(["src/App.tsx", "src/lib/github.ts", "public/logo.png"]);
    const result = toggleSelection(start, "src");
    expect(result.has("src")).toBe(true);
    expect(result.has("src/App.tsx")).toBe(false);
    expect(result.has("src/lib/github.ts")).toBe(false);
    // Unrelated selection outside the folder is untouched.
    expect(result.has("public/logo.png")).toBe(true);
  });

  it("keeps the tree-covered state and the deletion target set consistent", () => {
    // Regression guard: selecting a folder must make every descendant file
    // report as covered, matching what the server will actually delete.
    let selected = new Set<string>();
    selected = toggleSelection(selected, "src");
    for (const e of entries.filter((e) => e.path.startsWith("src/"))) {
      expect(isPathCovered(e.path, selected)).toBe(true);
    }
    expect(isPathCovered("public/logo.png", selected)).toBe(false);
  });
});

describe("buildTree ordering", () => {
  it("puts folders before files and sorts each folder by name, once, at build time", () => {
    const tree = buildTree([
      { path: "zeta.txt", type: "blob", sha: "1" },
      { path: "beta", type: "tree", sha: "2" },
      { path: "Alpha.txt", type: "blob", sha: "3" },
      { path: "alpha", type: "tree", sha: "4" },
      { path: "beta/z.ts", type: "blob", sha: "5" },
      { path: "beta/a.ts", type: "blob", sha: "6" },
      { path: "beta/lib", type: "tree", sha: "7" },
    ]);
    expect(tree.map((n) => n.name)).toEqual(["alpha", "beta", "Alpha.txt", "zeta.txt"]);
    expect(tree[1].children.map((n) => n.name)).toEqual(["lib", "a.ts", "z.ts"]);
  });

  it("puts an entry whose parent is missing at the top level", () => {
    const tree = buildTree([{ path: "ghost/file.txt", type: "blob", sha: "1" }]);
    expect(tree.map((n) => n.path)).toEqual(["ghost/file.txt"]);
  });

  it("builds a 20,000-entry tree quickly", () => {
    const big: RepoTreeEntry[] = [];
    for (let d = 0; d < 200; d++) {
      big.push({ path: `dir${d}`, type: "tree", sha: `d${d}` });
      for (let f = 0; f < 100; f++) big.push({ path: `dir${d}/file${f}.ts`, type: "blob", sha: `f${d}-${f}` });
    }
    const t0 = performance.now();
    const tree = buildTree(big);
    const ms = performance.now() - t0;
    expect(tree).toHaveLength(200);
    expect(tree[0].children).toHaveLength(100);
    expect(ms).toBeLessThan(1000);
  });
});

describe("flattenTree", () => {
  const tree = buildTree(entries);

  it("lists every node in display order with its depth", () => {
    expect(flattenTree(tree, new Set()).map((r) => `${r.depth}:${r.node.path}`)).toEqual([
      "0:public",
      "1:public/logo.png",
      "0:src",
      "1:src/lib",
      "2:src/lib/github.ts",
      "1:src/App.tsx",
      "0:README.md",
    ]);
  });

  it("leaves out the contents of collapsed folders, but not the folder itself", () => {
    const rows = flattenTree(tree, new Set(["src"]));
    expect(rows.map((r) => r.node.path)).toEqual(["public", "public/logo.png", "src", "README.md"]);
  });

  it("only a collapsed folder hides its own contents", () => {
    const rows = flattenTree(tree, new Set(["src/lib"]));
    expect(rows.map((r) => r.node.path)).toContain("src/lib");
    expect(rows.map((r) => r.node.path)).not.toContain("src/lib/github.ts");
    expect(rows.map((r) => r.node.path)).toContain("src/App.tsx");
  });
});

describe("visibleRange", () => {
  it("renders the rows in view plus overscan on each side", () => {
    // 384px / 32px = 12 rows in view (+1 for a partly visible row), 8 overscan.
    expect(visibleRange(100, 384, 32, 5000, 8)).toEqual({ start: 92, end: 100 + 13 + 8 });
  });

  it("clamps at the top and bottom of the list", () => {
    expect(visibleRange(0, 384, 32, 5000, 8)).toEqual({ start: 0, end: 21 });
    expect(visibleRange(4995, 384, 32, 5000, 8)).toEqual({ start: 4987, end: 5000 });
  });

  it("shows everything for a short list", () => {
    expect(visibleRange(0, 384, 32, 5, 8)).toEqual({ start: 0, end: 5 });
    expect(visibleRange(0, 384, 32, 0, 8)).toEqual({ start: 0, end: 0 });
  });

  it("copes with a scroll position past the end (the list just got shorter)", () => {
    const { start, end } = visibleRange(900, 384, 32, 10, 8);
    expect(end).toBe(10);
    expect(start).toBeLessThanOrEqual(10);
  });
});
