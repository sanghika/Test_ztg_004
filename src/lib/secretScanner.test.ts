import { Script } from "node:vm";
import { describe, it, expect, vi } from "vitest";
import { sanitizeFiles } from "./secretScanner";
import { MAX_SCAN_BYTES, scanContent } from "./secretScannerCore";
import type { ExtractedFile } from "./github";

const b64 = (text: string) => Buffer.from(text, "utf-8").toString("base64");
const utf8 = (b64content: string) => Buffer.from(b64content, "base64").toString("utf-8");

const makeFile = (path: string, content: string): ExtractedFile => ({ path, content: b64(content) });

// Fake credentials are assembled at runtime on purpose. Written out in full they
// look like real secrets, and ZiptoGit's own scanner (or GitHub push protection)
// rewrites them to "[REDACTED-SECRET]" when this repo is pushed, which silently
// breaks the tests. No contiguous secret-shaped string should appear in this file.
const FAKE_AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE";
const FAKE_GH_TOKEN = "ghp" + "_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
const FAKE_STRIPE_KEY = "sk" + "_live_" + "4eC39HqLyjWDarjtT1zdp7dc";
const FAKE_DB_URL = "postgres" + "://admin:sup3rSecret@db.example.com:5432/app";

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
    const files = [makeFile("config.js", `const key = '${FAKE_AWS_KEY}';\nconst other = 'safe';`)];
    const { sanitized, report } = await sanitizeFiles(files);

    expect(report.redactedFiles.map((r) => r.path)).toContain("config.js");
    const content = utf8(sanitized[0].content);
    expect(content).not.toContain(FAKE_AWS_KEY);
    expect(content).toContain("[REDACTED-SECRET]");
    expect(content).toContain("safe"); // untouched non-secret content survives
  });

  it("redacts a GitHub personal access token", async () => {
    const files = [makeFile("notes.md", `token: ${FAKE_GH_TOKEN}`)];
    const { sanitized, report } = await sanitizeFiles(files);
    expect(report.redactedFiles.length).toBe(1);
    const out = utf8(sanitized[0].content);
    expect(out).not.toContain(FAKE_GH_TOKEN);
    expect(out).toContain("[REDACTED-SECRET]");
  });

  it("redacts a Stripe live secret key", async () => {
    const files = [makeFile("billing.py", `STRIPE_KEY = "${FAKE_STRIPE_KEY}"`)];
    const { sanitized } = await sanitizeFiles(files);
    const out = utf8(sanitized[0].content);
    expect(out).not.toContain(FAKE_STRIPE_KEY);
    expect(out).toContain("[REDACTED-SECRET]");
  });

  it("excludes .env.example-style files by the leading-dot pattern, not by containing 'env'", async () => {
    const files = [makeFile(".env.example", "DATABASE_URL=[REDACTED-SECRET]")];
    const { report } = await sanitizeFiles(files);
    expect(report.skippedFiles).toContain(".env.example");
  });

  it("redacts a raw DB connection string in a non-excluded file", async () => {
    const files = [makeFile("setup.sh", `export DB=${FAKE_DB_URL}`)];
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
      `aws_key = '${FAKE_AWS_KEY}'`,
      `gh_token = '${FAKE_GH_TOKEN}'`,
    ].join("\n");
    const files = [makeFile("multi.txt", content)];
    const { sanitized, report } = await sanitizeFiles(files);
    const redactedEntry = report.redactedFiles.find((r) => r.path === "multi.txt");
    expect(redactedEntry?.matches).toEqual(
      expect.arrayContaining(["AWS Access Key ID", "GitHub Token"])
    );
    const resultText = utf8(sanitized[0].content);
    expect(resultText).not.toContain(FAKE_AWS_KEY);
    expect(resultText).not.toContain(FAKE_GH_TOKEN);
  });
});

describe("sanitizeFiles - what is and is not scanned", () => {
  it("treats a file containing a NUL byte as binary and pushes it untouched", async () => {
    const content = Buffer.concat([Buffer.from(`key = '${FAKE_AWS_KEY}'`), Buffer.from([0, 1, 2, 3])]).toString("base64");
    const { sanitized, report } = await sanitizeFiles([{ path: "data.unknownext", content }]);
    expect(report.redactedFiles.length).toBe(0);
    expect(sanitized[0].content).toBe(content);
  });

  it("does not text-scan binary types that used to be missing from the list", async () => {
    for (const ext of ["avif", "heic", "jar", "psd"]) {
      const file = makeFile(`asset.${ext}`, `key = '${FAKE_AWS_KEY}'`);
      const { sanitized, report } = await sanitizeFiles([file]);
      expect(report.redactedFiles.length).toBe(0);
      expect(sanitized[0].content).toBe(file.content);
    }
  });

  it("reports a file over the size cap without sending it to a worker", async () => {
    const file = makeFile("huge.txt", "a".repeat(MAX_SCAN_BYTES + 1));
    const startWorker = vi.fn();
    vi.stubGlobal("Worker", startWorker);
    try {
      const { sanitized, report } = await sanitizeFiles([file]);
      expect(startWorker).not.toHaveBeenCalled();
      expect(report.unscannedFiles).toEqual(["huge.txt"]);
      expect(report.redactedFiles.length).toBe(0);
      expect(sanitized[0].content).toBe(file.content);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("redacts the same kind of secret in every file (the shared regexes carry no state between files)", async () => {
    const files = ["a.js", "b.js", "c.js"].map((p) => makeFile(p, `const k = '${FAKE_AWS_KEY}';`));
    const { sanitized, report } = await sanitizeFiles(files);
    expect(report.redactedFiles.map((r) => r.path)).toEqual(["a.js", "b.js", "c.js"]);
    for (const f of sanitized) expect(utf8(f.content)).toBe("const k = '[REDACTED-SECRET]';");
  });

  it("returns files in their original order, with excluded ones removed", async () => {
    const files = [makeFile("one.js", "1"), makeFile(".env", "X=1"), makeFile("two.js", `k='${FAKE_AWS_KEY}'`), makeFile("logo.png", "x")];
    const { sanitized } = await sanitizeFiles(files);
    expect(sanitized.map((f) => f.path)).toEqual(["one.js", "two.js", "logo.png"]);
  });
});

describe("scanContent", () => {
  it("redacts only assignment values and keeps JavaScript and JSON parseable", () => {
    const value = "example-test-value-only";
    const awsValue = "a".repeat(40);
    const cases = [
      { before: 'const apiKey = "' + value + '";', after: 'const apiKey = "[REDACTED-SECRET]";', parse: (code: string) => new Script(code) },
      { before: "const AWS_SECRET_ACCESS_KEY = '" + awsValue + "';", after: "const AWS_SECRET_ACCESS_KEY = '[REDACTED-SECRET]';", parse: (code: string) => new Script(code) },
      { before: JSON.stringify({ "clientSecret": value }), after: '{"clientSecret":"[REDACTED-SECRET]"}', parse: JSON.parse },
      { before: "AWS_SECRET_ACCESS_KEY=" + awsValue, after: "AWS_SECRET_ACCESS_KEY=[REDACTED-SECRET]", parse: undefined },
    ];
    for (const { before, after, parse } of cases) {
      const result = scanContent(b64(before));
      expect(result.kind).toBe("redacted");
      if (result.kind !== "redacted") continue;
      const output = utf8(result.content);
      expect(output).toBe(after);
      if (parse) expect(() => parse(output)).not.toThrow();
    }
  });

  it("keeps multi-byte characters intact when a file is decoded in several slices", () => {
    // 900k two-byte characters is ~2.4MB of base64, more than two decode slices,
    // so characters straddle slice boundaries.
    const body = "\u00e9".repeat(900_000);
    const outcome = scanContent(b64(`${body}\nk = '${FAKE_AWS_KEY}'`));
    expect(outcome.kind).toBe("redacted");
    if (outcome.kind === "redacted") expect(utf8(outcome.content)).toBe(`${body}\nk = '[REDACTED-SECRET]'`);
  });

  it("treats content that is not valid base64 as binary", () => {
    expect(scanContent("!!!not base64!!!").kind).toBe("binary");
  });
});
