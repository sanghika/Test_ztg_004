import { describe, it, expect } from "vitest";
import { avatarSrc, AVATAR_PX, AVATAR_REQUEST_PX } from "./avatar";

describe("avatarSrc", () => {
  it("adds the size to a GitHub avatar URL that already has a query", () => {
    expect(avatarSrc("https://avatars.githubusercontent.com/u/583231?v=4")).toBe(
      "https://avatars.githubusercontent.com/u/583231?v=4&s=64",
    );
  });

  it("adds the size to a GitHub avatar URL with no query", () => {
    expect(avatarSrc("https://avatars.githubusercontent.com/u/583231")).toBe(
      "https://avatars.githubusercontent.com/u/583231?s=64",
    );
  });

  it("replaces a size that is already there instead of adding a second one", () => {
    expect(avatarSrc("https://avatars.githubusercontent.com/u/583231?v=4&s=460")).toBe(
      "https://avatars.githubusercontent.com/u/583231?v=4&s=64",
    );
  });

  it("accepts another size", () => {
    expect(avatarSrc("https://avatars.githubusercontent.com/u/1?v=4", 56)).toBe(
      "https://avatars.githubusercontent.com/u/1?v=4&s=56",
    );
  });

  it("leaves other hosts, empty strings and non-URLs alone", () => {
    expect(avatarSrc("https://example.com/me.png")).toBe("https://example.com/me.png");
    expect(avatarSrc("https://githubusercontent.com.evil.test/u/1")).toBe("https://githubusercontent.com.evil.test/u/1");
    expect(avatarSrc("")).toBe("");
    expect(avatarSrc("not a url")).toBe("not a url");
  });

  it("requests at least 2x the drawn size", () => {
    expect(AVATAR_REQUEST_PX).toBeGreaterThanOrEqual(AVATAR_PX * 2);
  });
});
