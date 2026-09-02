import { MCP_JSON_MAX_BODY_BYTES, MCP_PROVISIONING_MAX_BODY_BYTES } from "@pocketcircle/domain";

export { MCP_JSON_MAX_BODY_BYTES, MCP_PROVISIONING_MAX_BODY_BYTES };

/**
 * Reads a JSON body, rejecting when Content-Length or streamed size exceeds
 * `maxBytes`. Returns null for oversized, empty, or non-UTF-8/non-JSON input.
 * Prefer this over `request.json()` so oversized payloads never reach Convex.
 */
export async function readBoundedJson(request: Request, maxBytes: number) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return null;
  }
  if (!request.body) {
    return null;
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    size += chunk.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
    return parsed;
  } catch {
    return null;
  }
}

/** True when Content-Length alone already exceeds the ceiling (cheap pre-check). */
export function contentLengthExceeds(request: Request, maxBytes: number) {
  const declaredLength = Number(request.headers.get("content-length"));
  return Number.isFinite(declaredLength) && declaredLength > maxBytes;
}
