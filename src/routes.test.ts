import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { HOME_TITLE, PAGE_TITLES, PRERENDER_ROUTES } from "./routes";

describe("home title", () => {
  it("is the <title> that index.html (and so the prerendered home page) ships with", () => {
    const html = fs.readFileSync(path.resolve(__dirname, "..", "index.html"), "utf8");
    const match = html.match(/<title>([^<]*)<\/title>/);
    expect(match?.[1]).toBe(HOME_TITLE);
  });
});

describe("content page titles", () => {
  it("are the same text the prerender writes into the static HTML", () => {
    for (const route of PRERENDER_ROUTES) {
      if (route.path === "/") continue;
      expect(route.title).toBe(`${PAGE_TITLES[route.path as keyof typeof PAGE_TITLES]} | ZiptoGit`);
    }
  });
});
