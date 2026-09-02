import {
  contentLengthExceeds,
  MCP_JSON_MAX_BODY_BYTES,
  MCP_PROVISIONING_MAX_BODY_BYTES,
} from "@pocketcircle/domain";

export { contentLengthExceeds, MCP_JSON_MAX_BODY_BYTES, MCP_PROVISIONING_MAX_BODY_BYTES };

/**
 * Reads a JSON body, rejecting when Content-Length or streamed size exceeds
 * `maxBytes`. Returns null for oversized, empty, or non-UTF-8/non-JSON input.
 * Prefer this over `request.json()` so oversized payloads never reach Convex.
 */
export async function readBoundedJson(request: Request, maxBytes: number) {
  if (contentLengthExceeds(request.headers, maxBytes)) {
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

/**
 * Streams a clone of the body and returns false if it exceeds `maxBytes`.
 * Leaves the original request body unread for downstream handlers.
 */
export async function assertClonedBodyWithinLimit(request: Request, maxBytes: number) {
  if (contentLengthExceeds(request.headers, maxBytes)) {
    return false;
  }
  if (request.method.toUpperCase() === "GET" || request.method.toUpperCase() === "HEAD") {
    return true;
  }
  if (!request.body) {
    return true;
  }
  const reader = request.clone().body?.getReader();
  if (!reader) {
    return true;
  }
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      return true;
    }
    size += chunk.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return false;
    }
  }
}
