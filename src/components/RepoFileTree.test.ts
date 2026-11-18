import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import RepoFileTree from "./RepoFileTree";
import type { RepoTreeEntry } from "../lib/github";

// Rendered on the server (no DOM in this test environment): enough to prove
// how many rows end up in the page, and what they look like.
const render = (entries: RepoTreeEntry[], selected = new Set<string>()) =>
  renderToStaticMarkup(createElement(RepoFileTree, { entries, selected, onChange: () => {} }));

const bigRepo = (files: number): RepoTreeEntry[] => {
  const entries: RepoTreeEntry[] = [];
  for (let i = 0; i < files; i++) entries.push({ path: `file-${String(i).padStart(5, "0")}.ts`, type: "blob", sha: `s${i}` });
  return entries;
};

const rowCount = (html: string) => (html.match(/role="listitem"/g) || []).length;

describe("RepoFileTree", () => {
  it("renders only a window of rows for a 5,000-file repository", () => {
    const html = render(bigRepo(5000));
    expect(rowCount(html)).toBeLessThan(40);
    expect(rowCount(html)).toBeGreaterThan(10);
    // ...but the scroll box is still as tall as the whole list (5,000 × 32px).
    expect(html).toContain("height:160000px");
    expect(html).toContain('aria-setsize="5000"');
    // About 8 DOM nodes per row before; the page now holds a few hundred, not tens of thousands.
    expect((html.match(/<[a-z]/g) || []).length).toBeLessThan(1000);
  });

  it("renders every row of a small repository, folders first", () => {
    const html = render([
      { path: "README.md", type: "blob", sha: "1" },
      { path: "src", type: "tree", sha: "2" },
      { path: "src/App.tsx", type: "blob", sha: "3" },
    ]);
    expect(rowCount(html)).toBe(3);
    expect(html.indexOf("src")).toBeLessThan(html.indexOf("README.md"));
    expect(html).toContain('aria-label="Collapse src folder"');
  });

  it("shows files under a selected folder as covered and their boxes disabled", () => {
    const html = render(
      [
        { path: "src", type: "tree", sha: "1" },
        { path: "src/App.tsx", type: "blob", sha: "2" },
        { path: "other.txt", type: "blob", sha: "3" },
      ],
      new Set(["src"])
    );
    // src (checked, enabled) + src/App.tsx (checked, disabled) are struck through; other.txt is not.
    expect((html.match(/line-through/g) || []).length).toBe(2);
    expect((html.match(/disabled=""/g) || []).length).toBe(1);
    expect((html.match(/checked=""/g) || []).length).toBe(2);
  });

  it("draws one guide line per level of nesting", () => {
    const html = render([
      { path: "a", type: "tree", sha: "1" },
      { path: "a/b", type: "tree", sha: "2" },
      { path: "a/b/c.txt", type: "blob", sha: "3" },
    ]);
    // a: none, a/b: one, a/b/c.txt: two.
    expect((html.match(/bg-edge-subtle/g) || []).length).toBe(3);
  });
});
