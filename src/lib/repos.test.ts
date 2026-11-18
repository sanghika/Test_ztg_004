import { describe, it, expect } from "vitest";
import { mergeRepos } from "./repos";

const r = (id: number) => ({ id, name: `r${id}`, full_name: `me/r${id}` });

describe("mergeRepos", () => {
  it("appends a new page after the existing repos, in order", () => {
    expect(mergeRepos([r(1), r(2)], [r(3), r(4)]).map((x) => x.id)).toEqual([1, 2, 3, 4]);
  });

  it("skips repos already shown (a repo created meanwhile shifts later pages by one)", () => {
    expect(mergeRepos([r(9), r(1), r(2)], [r(2), r(3)]).map((x) => x.id)).toEqual([9, 1, 2, 3]);
  });

  it("returns the same array when the page adds nothing", () => {
    const existing = [r(1)];
    expect(mergeRepos(existing, [r(1)])).toBe(existing);
    expect(mergeRepos(existing, [])).toBe(existing);
  });

  it("does not mutate its inputs", () => {
    const existing = [r(1)];
    const incoming = [r(2)];
    mergeRepos(existing, incoming);
    expect(existing.length).toBe(1);
    expect(incoming.length).toBe(1);
  });
});
