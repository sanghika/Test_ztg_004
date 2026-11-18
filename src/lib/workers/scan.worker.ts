// Runs the secret scan off the main thread. See secretScanner.ts for the caller
// and the message shapes. Only files that were changed (redacted) or not
// scanned (too large) are sent back; everything else stays where it is.
import { scanContent } from "../secretScannerCore";

const scope = self as unknown as {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
};

scope.postMessage({ type: "ready" });

scope.onmessage = (event: MessageEvent<{ files: { index: number; content: string }[] }>) => {
  try {
    const results: ({ index: number; kind: "too-large" } | { index: number; kind: "redacted"; content: string; matches: string[] })[] = [];
    for (const { index, content } of event.data.files) {
      const outcome = scanContent(content);
      if (outcome.kind === "redacted" || outcome.kind === "too-large") results.push({ index, ...outcome });
    }
    scope.postMessage({ type: "done", result: results });
  } catch (err: any) {
    scope.postMessage({ type: "error", message: err?.message || "Scanning failed." });
  }
};
