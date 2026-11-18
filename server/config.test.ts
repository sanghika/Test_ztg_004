import { describe, expect, it } from "vitest";
import { readAuthConfig, readPort } from "./config";

const production = {
  NODE_ENV: "production",
  APP_URL: "https://ziptogit.in/",
  GITHUB_CLIENT_ID: "example-client",
  GITHUB_CLIENT_SECRET: "example-oauth-secret",
  SESSION_SECRET: "example-signing-secret",
};

describe("production configuration", () => {
  it("fails when OAuth or session settings are missing", () => {
    expect(() => readAuthConfig({ NODE_ENV: "production" }))
      .toThrow("GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, SESSION_SECRET, APP_URL");
    expect(() => readAuthConfig({ ...production, SESSION_SECRET: " " }))
      .toThrow("SESSION_SECRET");
  });

  it("requires a dedicated signing secret", () => {
    for (const secret of [production.GITHUB_CLIENT_SECRET, "dev-only-insecure-secret"]) {
      expect(() => readAuthConfig({ ...production, SESSION_SECRET: secret })).toThrow("dedicated");
    }
  });

  it("normalizes the public origin for the callback and allows local preview", () => {
    expect(readAuthConfig(production).appOrigin).toBe("https://ziptogit.in");
    expect(readAuthConfig({ ...production, APP_URL: "http://localhost:4182" }).appOrigin)
      .toBe("http://localhost:4182");
  });

  it.each(["bad-url", "http://ziptogit.in", "https://ziptogit.in/path", "https://ziptogit.in/?ref=1"])(
    "rejects an invalid production origin (%s)",
    (APP_URL) => expect(() => readAuthConfig({ ...production, APP_URL })).toThrow("APP_URL"),
  );
});

describe("server port", () => {
  it("uses the hosting port or defaults to 3000", () => {
    expect(readPort("4182")).toBe(4182);
    expect(readPort(undefined)).toBe(3000);
  });

  it.each(["", "0", "65536", "3000x", "-1"])("rejects an invalid port (%s)", (value) => {
    expect(() => readPort(value)).toThrow("PORT");
  });
});
