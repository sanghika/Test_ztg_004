// The scanning itself, with no knowledge of threads. Used two ways: by
// workers/scan.worker.ts (the normal path, off the main thread) and directly
// by secretScanner.ts (small jobs, or a browser without Web Workers).
// Keep this file free of anything that touches the DOM so both can load it,
// and import only *types* from ./github so the worker bundle stays small.
import { estimateBytesFromBase64, MAX_SCAN_BYTES } from "./uploadLimits";

// --- File extensions/paths that are excluded entirely (never pushed) --- //
// These are files that are almost always sensitive on their own, so redacting
// individual lines isn't enough - we drop them from the push completely.
export const EXCLUDED_PATH_PATTERNS: RegExp[] = [
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
// Files with these extensions are pushed untouched. This is only a shortcut:
// anything not listed here is still caught by the NUL-byte check in
// base64ToText, so a missing extension costs a little time, not correctness.
export const BINARY_EXTENSIONS = new Set([
  // images
  "png","jpg","jpeg","gif","webp","ico","bmp","tiff","tif","svg","avif","heic","heif","jxl","jp2","psd","icns","cur","dds","tga","exr",
  // fonts
  "woff","woff2","ttf","eot","otf",
  // archives and packages
  "zip","gz","tgz","bz2","xz","zst","tar","rar","7z","jar","war","ear","apk","ipa","deb","rpm","msi","dmg","iso","cab",
  // documents
  "pdf","doc","docx","xls","xlsx","ppt","pptx","odt","ods","odp","epub",
  // audio and video
  "mp3","mp4","mov","avi","wav","ogg","flac","aac","m4a","m4v","mkv","webm","wmv","wma","flv","mid","midi",
  // compiled code and data
  "exe","dll","so","dylib","bin","wasm","class","pyc","pyo","o","a","lib",
  "db","sqlite","sqlite3","parquet","npy","npz","pkl","pickle","h5","hdf5","onnx","pt","pth","ckpt","safetensors","tflite",
]);

export { MAX_SCAN_BYTES };

// --- Secret detection patterns: [name, regex] --- //
// Each regex should match the secret token itself so it can be redacted in place.
// Compiled once, when this module loads. They are shared between files, which
// is safe because String.prototype.replace resets lastIndex of a global regex
// before it starts; never call .test() or .exec() on these.
export const SECRET_PATTERNS: { name: string; regex: RegExp }[] = [
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

export const isBinaryPath = (path: string): boolean => {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return BINARY_EXTENSIONS.has(ext);
};

export const isExcludedPath = (path: string): boolean =>
  EXCLUDED_PATH_PATTERNS.some((re) => re.test(path));

// Decoded a slice at a time, so only one slice of raw bytes exists at once
// (the old version held the whole binary string, a byte array and the decoded
// text together: roughly 3-4x the file size). Must be a multiple of 4 so every
// slice is valid base64 on its own.
const DECODE_CHUNK_CHARS = 1 << 20;

/**
 * Decodes base64 to text, or returns null if the content is binary: a NUL byte
 * anywhere in it means it is not text (UTF-8 text never contains one), and the
 * scan stops at the first one instead of decoding the rest. Throws if the input
 * is not valid base64; callers treat that as binary too.
 */
export const base64ToText = (b64: string): string | null => {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const parts: string[] = [];
  for (let i = 0; i < b64.length; i += DECODE_CHUNK_CHARS) {
    const binary = atob(b64.slice(i, i + DECODE_CHUNK_CHARS));
    const bytes = new Uint8Array(binary.length);
    for (let j = 0; j < binary.length; j++) {
      const code = binary.charCodeAt(j);
      if (code === 0) return null;
      bytes[j] = code;
    }
    // stream: a multi-byte character split across two slices is kept whole.
    parts.push(decoder.decode(bytes, { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join("");
};

// Converting large byte arrays to base64 one char at a time via
// String.fromCharCode() in a loop can freeze the tab on files approaching
// the app's 50MB upload limit (each += grows and re-copies the string).
// Chunking through String.fromCharCode(...spread) keeps each intermediate
// string bounded regardless of file size.
const UTF8_TO_BASE64_CHUNK_SIZE = 8192;
export const utf8ToBase64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += UTF8_TO_BASE64_CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + UTF8_TO_BASE64_CHUNK_SIZE);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
};

export type ScanOutcome =
  | { kind: "clean" }                                 // text, nothing found: push as is
  | { kind: "binary" }                                // not text (NUL byte / not decodable): push as is
  | { kind: "too-large" }                             // over MAX_SCAN_BYTES: push as is, report it
  | { kind: "redacted"; content: string; matches: string[] }; // push `content` (base64) instead

/** Scans one file's base64 content. Pure and synchronous. */
export const scanContent = (base64: string): ScanOutcome => {
  if (estimateBytesFromBase64(base64) > MAX_SCAN_BYTES) return { kind: "too-large" };

  let text: string | null;
  try {
    text = base64ToText(base64);
  } catch {
    // Not decodable - treat as binary and leave untouched.
    return { kind: "binary" };
  }
  if (text === null) return { kind: "binary" };

  let redactedText = text;
  const matches: string[] = [];
  for (const { name, regex } of SECRET_PATTERNS) {
    let matched = false;
    redactedText = redactedText.replace(regex, () => {
      matched = true;
      return "[REDACTED-SECRET]";
    });
    if (matched) matches.push(name);
  }

  return matches.length > 0
    ? { kind: "redacted", content: utf8ToBase64(redactedText), matches }
    : { kind: "clean" };
};
