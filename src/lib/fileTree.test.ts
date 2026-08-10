import { describe, it, expect } from "vitest";
import { buildTree, isPathCovered, toggleSelection } from "./fileTree";
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
