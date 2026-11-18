import { encodeUploadBody } from "../uploadBody";

const scope = self as unknown as {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
};

scope.postMessage({ type: "ready" });

scope.onmessage = async (event: MessageEvent<unknown>) => {
  try {
    scope.postMessage({ type: "done", result: await encodeUploadBody(event.data) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not prepare upload data.";
    scope.postMessage({ type: "error", message });
  }
};
