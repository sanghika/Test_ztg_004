import { describe, it, expect } from "vitest";
import { isPathRemoved } from "./githubService";

describe("isPathRemoved", () => {
  it("matches an exact selected file path", () => {
    expect(isPathRemoved("README.md", ["README.md"])).toBe(true);
    expect(isPathRemoved("other.md", ["README.md"])).toBe(false);
  });

  it("matches every file nested under a selected folder", () => {
    const selected = ["src"];
    expect(isPathRemoved("src/App.tsx", selected)).toBe(true);
    expect(isPathRemoved("src/lib/github.ts", selected)).toBe(true);
    expect(isPathRemoved("src", selected)).toBe(true);
  });

  it("does not match a sibling folder with a similar name prefix", () => {
    // "src" must not accidentally also match "src-old/..." — this is the
    // exact bug class that would delete unrelated files if the matching
    // used startsWith("src") instead of startsWith("src/").
    expect(isPathRemoved("src-old/file.ts", ["src"])).toBe(false);
    expect(isPathRemoved("src-old", ["src"])).toBe(false);
  });

  it("does not match files outside any selected path", () => {
    expect(isPathRemoved("public/logo.png", ["src", "README.md"])).toBe(false);
  });

  it("handles a selected folder path with a trailing slash the same as without", () => {
    expect(isPathRemoved("src/App.tsx", ["src/"])).toBe(true);
    expect(isPathRemoved("src", ["src/"])).toBe(true);
  });

  it("supports multiple independent selections at once", () => {
    const selected = ["src/lib", "README.md", "public/logo.png"];
    expect(isPathRemoved("src/lib/github.ts", selected)).toBe(true);
    expect(isPathRemoved("README.md", selected)).toBe(true);
    expect(isPathRemoved("public/logo.png", selected)).toBe(true);
    expect(isPathRemoved("src/App.tsx", selected)).toBe(false);
    expect(isPathRemoved("public/social.png", selected)).toBe(false);
  });

  it("returns false when nothing is selected", () => {
    expect(isPathRemoved("anything.txt", [])).toBe(false);
  });
});
