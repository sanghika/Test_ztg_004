// Ignore generated output, VCS metadata, and OS files in both ZIPs and folders.
const EXCLUDED_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  ".parcel-cache",
  "dist",
  "build",
  "coverage",
  "__MACOSX",
  ".DS_Store",
]);
const EXCLUDED_FILE_NAMES = new Set([".DS_Store", "Thumbs.db"]);

export const shouldSkipUploadPath = (relativePath: string): boolean => {
  const segments = relativePath.split(/[\\/]/);
  const fileName = segments[segments.length - 1];
  if (EXCLUDED_FILE_NAMES.has(fileName)) return true;
  return segments.some((seg) => EXCLUDED_DIR_NAMES.has(seg));
};
