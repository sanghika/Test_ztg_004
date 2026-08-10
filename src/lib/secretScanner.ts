import { ExtractedFile } from "./github";

// --- File extensions/paths that are excluded entirely (never pushed) --- //
// These are files that are almost always sensitive on their own, so redacting
// individual lines isn't enough - we drop them from the push completely.
const EXCLUDED_PATH_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\..*)?$/i,                 // .env, .env.local, .env.production, etc.
  /(^|\/)id_rsa(\.pub)?$/i,
  /(^|\/)id_ed25519(\.pub)?$/i,
  /(^|\/).*\.pem$/i,
  /(^|\/).*\.pfx$/i,
  /(^|\/).*\.p12$/i,
  /(^|\/)credentials\.json$/i,
  /(^|\/)service-?account.*\.json$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.pypirc$/i,
  /(^|\/)\.aws\/credentials$/i,
  /(^|\/)\.ssh\/.*$/i,
];

// --- Binary/asset extensions we should never attempt to text-scan --- //
const BINARY_EXTENSIONS = new Set([
  "png","jpg","jpeg","gif","webp","ico","bmp","tiff","svg",
  "woff","woff2","ttf","eot","otf",
  "zip","gz","tar","rar","7z",
  "pdf","mp3","mp4","mov","avi","wav","ogg",
  "exe","dll","so","dylib","bin","wasm",
  "db","sqlite","sqlite3",
]);

// --- Secret detection patterns: [name, regex] --- //
// Each regex should match the secret token itself so it can be redacted in place.
const SECRET_PATTERNS: { name: string; regex: RegExp }[] = [
  { name: "AWS Access Key ID", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "AWS Secret Access Key", regex: /\b(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[:=]\s*["']?[A-Za-z0-9\/+=]{40}["']?/g },
  { name: "GitHub Token", regex: /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,255}\b/g },
  { name: "Google API Key", regex: /\bAIza[0-9A-Za-z\-_]{35}\b/g },
  { name: "Stripe Key", regex: /\b(sk|rk|pk)_(live|test)_[0-9a-zA-Z]{16,247}\b/g },
  { name: "Slack Token", regex: /\bxox[baprs]-[0-9A-Za-z-]{10,72}\b/g },
  { name: "Slack Webhook", regex: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,60}/g },
  { name: "Private Key Block", regex: /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END \1?PRIVATE KEY-----/g },
  { name: "JWT", regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: "Firebase Server Key", regex: /\bAAAA[A-Za-z0-9_-]{7}:[A-Za-z0-9_-]{140}\b/g },
  { name: "Twilio API Key", regex: /\bSK[0-9a-fA-F]{32}\b/g },
  { name: "Generic API Key/Secret Assignment", regex: /\b((?:api|secret|access|client)[_-]?(?:key|token|secret))\s*[:=]\s*["']([A-Za-z0-9_\-\/+=]{16,})["']/gi },
  { name: "Database Connection String", regex: /\b(postgres|postgresql|mysql|mongodb(?:\+srv)?):\/\/[^:\s]+:[^@\s]+@[^\s"'`]+/gi },
];

export interface SanitizeReport {
  skippedFiles: string[];
  redactedFiles: { path: string; matches: string[] }[];
}

const isBinaryPath = (path: string): boolean => {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return BINARY_EXTENSIONS.has(ext);
};

const isExcludedPath = (path: string): boolean =>
  EXCLUDED_PATH_PATTERNS.some((re) => re.test(path));

const base64ToUtf8 = (b64: string): string => {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
};

// Converting large byte arrays to base64 one char at a time via
// String.fromCharCode() in a loop can freeze the tab on files approaching
// the app's 50MB upload limit (each += grows and re-copies the string).
// Chunking through String.fromCharCode(...spread) keeps each intermediate
// string bounded regardless of file size.
const UTF8_TO_BASE64_CHUNK_SIZE = 8192;
const utf8ToBase64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += UTF8_TO_BASE64_CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + UTF8_TO_BASE64_CHUNK_SIZE);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
};

/**
 * Scans extracted files for secrets before they are pushed to GitHub.
 * - Files matching known "always sensitive" paths (.env, private keys, credentials, etc.)
 *   are dropped entirely from the push.
 * - Other text files are scanned line-by-line for common secret patterns
 *   (cloud provider keys, tokens, private key blocks, DB connection strings, etc.)
 *   and any matches are replaced with a "[REDACTED-SECRET]" placeholder so the
 *   push still succeeds without leaking credentials.
 * - Binary files are left untouched (never text-scanned).
 *
 * Runs asynchronously and yields back to the event loop every few files
 * (mirroring extractZip's pattern in github.ts), so the upload spinner can
 * actually paint and the tab doesn't freeze on large file sets.
 */
export const sanitizeFiles = async (
  files: ExtractedFile[]
): Promise<{ sanitized: ExtractedFile[]; report: SanitizeReport }> => {
  const report: SanitizeReport = { skippedFiles: [], redactedFiles: [] };
  const sanitized: ExtractedFile[] = [];

  for (let idx = 0; idx < files.length; idx++) {
    const file = files[idx];
    if (idx % 10 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (isExcludedPath(file.path)) {
      report.skippedFiles.push(file.path);
      continue;
    }

    if (isBinaryPath(file.path)) {
      sanitized.push(file);
      continue;
    }

    let text: string;
    try {
      text = base64ToUtf8(file.content);
    } catch {
      // Not decodable as text - treat as binary and leave untouched.
      sanitized.push(file);
      continue;
    }

    let redactedText = text;
    const matchedNames: string[] = [];

    for (const { name, regex } of SECRET_PATTERNS) {
      const re = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : regex.flags + "g");
      let matched = false;
      redactedText = redactedText.replace(re, () => {
        matched = true;
        return "[REDACTED-SECRET]";
      });
      if (matched) {
        matchedNames.push(name);
      }
    }

    if (matchedNames.length > 0) {
      report.redactedFiles.push({ path: file.path, matches: matchedNames });
      sanitized.push({ path: file.path, content: utf8ToBase64(redactedText) });
    } else {
      sanitized.push(file);
    }
  }

  return { sanitized, report };
};
