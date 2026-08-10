import { describe, it, expect } from "vitest";
import { sanitizeFiles } from "./secretScanner";
import type { ExtractedFile } from "./github";

const b64 = (text: string) => Buffer.from(text, "utf-8").toString("base64");
const utf8 = (b64content: string) => Buffer.from(b64content, "base64").toString("utf-8");

const makeFile = (path: string, content: string): ExtractedFile => ({ path, content: b64(content) });

describe("sanitizeFiles", () => {
  it("excludes .env files entirely rather than redacting them", async () => {
    const files = [makeFile(".env", "SECRET=abc123"), makeFile("src/index.js", "console.log('hi')")];
    const { sanitized, report } = await sanitizeFiles(files);

    expect(report.skippedFiles).toContain(".env");
    expect(sanitized.find((f) => f.path === ".env")).toBeUndefined();
    expect(sanitized.find((f) => f.path === "src/index.js")).toBeDefined();
  });

  it("excludes nested .env, private keys, and credential files by path", async () => {
    const files = [
      makeFile("config/.env.production", "X=1"),
      makeFile("keys/id_rsa", "[REDACTED-SECRET]"),
      makeFile("certs/server.pem", "cert data"),
      makeFile("gcp/service-account.json", "{}"),
      makeFile(".npmrc", "//registry.npmjs.org/:_authToken=abc"),
    ];
    const { sanitized, report } = await sanitizeFiles(files);

    expect(report.skippedFiles.sort()).toEqual(
      [".npmrc", "certs/server.pem", "config/.env.production", "gcp/service-account.json", "keys/id_rsa"].sort()
    );
    expect(sanitized.length).toBe(0);
  });

  it("redacts an AWS access key embedded in an otherwise normal file", async () => {
    const files = [makeFile("config.js", "const key = '[REDACTED-SECRET]';\nconst other = 'safe';")];
    const { sanitized, report } = await sanitizeFiles(files);

    expect(report.redactedFiles.map((r) => r.path)).toContain("config.js");
    const content = utf8(sanitized[0].content);
    expect(content).not.toContain("[REDACTED-SECRET]");
    expect(content).toContain("[REDACTED-SECRET]");
    expect(content).toContain("safe"); // untouched non-secret content survives
  });

  it("redacts a GitHub personal access token", async () => {
    const files = [makeFile("notes.md", "token: [REDACTED-SECRET]")];
    const { sanitized, report } = await sanitizeFiles(files);
    expect(report.redactedFiles.length).toBe(1);
    expect(utf8(sanitized[0].content)).not.toMatch(/ghp_[A-Za-z0-9]+/);
  });

  it("redacts a Stripe live secret key", async () => {
    const files = [makeFile("billing.py", 'STRIPE_KEY = "[REDACTED-SECRET]"')];
    const { sanitized } = await sanitizeFiles(files);
    expect(utf8(sanitized[0].content)).not.toContain("[REDACTED-SECRET]");
  });

  it("excludes .env.example-style files by the leading-dot pattern, not by containing 'env'", async () => {
    const files = [makeFile(".env.example", "DATABASE_URL=[REDACTED-SECRET]")];
    const { report } = await sanitizeFiles(files);
    expect(report.skippedFiles).toContain(".env.example");
  });

  it("redacts a raw DB connection string in a non-excluded file", async () => {
    const files = [makeFile("setup.sh", "export DB=[REDACTED-SECRET]")];
    const { sanitized, report } = await sanitizeFiles(files);
    expect(report.redactedFiles.length).toBe(1);
    expect(utf8(sanitized[0].content)).not.toContain("sup3rSecret");
  });

  it("leaves files with no secrets completely untouched", async () => {
    const original = "export const greeting = 'hello world';\nfunction add(a,b) { return a+b; }";
    const files = [makeFile("util.ts", original)];
    const { sanitized, report } = await sanitizeFiles(files);

    expect(report.redactedFiles.length).toBe(0);
    expect(report.skippedFiles.length).toBe(0);
    expect(utf8(sanitized[0].content)).toBe(original);
  });

  it("does not attempt to text-scan binary/asset files by extension", async () => {
    // Deliberately invalid base64/text content that would throw or corrupt if decoded+redacted.
    const files: ExtractedFile[] = [{ path: "logo.png", content: "iVBORw0KGgoAAAANSUhEUgAAAAUA" }];
    const { sanitized } = await sanitizeFiles(files);
    expect(sanitized[0].content).toBe("iVBORw0KGgoAAAANSUhEUgAAAAUA"); // passed through unchanged
  });

  it("redacts multiple distinct secrets within the same file", async () => {
    const content = [
      "aws_key = '[REDACTED-SECRET]'",
      "gh_token = '[REDACTED-SECRET]'",
    ].join("\n");
    const files = [makeFile("multi.txt", content)];
    const { sanitized, report } = await sanitizeFiles(files);
    const redactedEntry = report.redactedFiles.find((r) => r.path === "multi.txt");
    expect(redactedEntry?.matches).toEqual(
      expect.arrayContaining(["AWS Access Key ID", "GitHub Token"])
    );
    const resultText = utf8(sanitized[0].content);
    expect(resultText).not.toContain("[REDACTED-SECRET]");
    expect(resultText).not.toContain("[REDACTED-SECRET]");
  });
});
