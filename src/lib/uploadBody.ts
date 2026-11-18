export type PreparedUploadBody = {
  payload: BodyInit;
  contentEncoding?: "gzip";
};

export async function encodeUploadBody(body: unknown): Promise<PreparedUploadBody> {
  const json = JSON.stringify(body);
  if (typeof Blob === "undefined") return { payload: json };

  // Browsers can pass a Blob back from a worker without copying the full JSON
  // string to the main thread, including when compression is unavailable.
  const payload = new Blob([json]);
  if (typeof CompressionStream === "undefined") return { payload };

  try {
    const stream = payload.stream().pipeThrough(new CompressionStream("gzip"));
    return { payload: await new Response(stream).blob(), contentEncoding: "gzip" };
  } catch {
    return { payload };
  }
}
