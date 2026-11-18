import { describe, it, expect } from "vitest";
import { hasSessionFlag } from "./session";

describe("hasSessionFlag", () => {
  it("is true when has_session=1 is the only cookie", () => {
    expect(hasSessionFlag("has_session=1")).toBe(true);
  });

  it("is true when it sits among other cookies, at either end or in the middle", () => {
    expect(hasSessionFlag("a=b; has_session=1")).toBe(true);
    expect(hasSessionFlag("has_session=1; a=b")).toBe(true);
    expect(hasSessionFlag("a=b; has_session=1; c=d")).toBe(true);
  });

  it("is false with no cookies or without the flag", () => {
    expect(hasSessionFlag("")).toBe(false);
    expect(hasSessionFlag("a=b; c=d")).toBe(false);
  });

  it("is false for any value other than 1", () => {
    expect(hasSessionFlag("has_session=0")).toBe(false);
    expect(hasSessionFlag("has_session=")).toBe(false);
    expect(hasSessionFlag("has_session=10")).toBe(false);
  });

  it("is not fooled by a cookie whose name only ends in has_session", () => {
    expect(hasSessionFlag("not_has_session=1")).toBe(false);
    expect(hasSessionFlag("a=b; x_has_session=1")).toBe(false);
  });
});
