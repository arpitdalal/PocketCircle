import {
  contentLengthExceeds,
  MCP_JSON_MAX_BODY_BYTES,
  MCP_PROVISIONING_MAX_BODY_BYTES,
  MCP_TOKEN_MAX_BODY_BYTES,
  readBoundedUtf8,
} from "@pocketcircle/domain";

export {
  contentLengthExceeds,
  MCP_JSON_MAX_BODY_BYTES,
  MCP_PROVISIONING_MAX_BODY_BYTES,
  MCP_TOKEN_MAX_BODY_BYTES,
  readBoundedUtf8,
};

/**
 * Reads a JSON body, rejecting when Content-Length or streamed size exceeds
 * `maxBytes`. Returns null for oversized, empty, or non-UTF-8/non-JSON input.
 */
export async function readBoundedJson(request: Request, maxBytes: number) {
  const text = await readBoundedUtf8(request, maxBytes);
  if (text === null || text.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
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
  // Clone tees the body. If the clone hits the ceiling, cancel both branches
  // without awaiting — awaiting one tee cancel while the sibling stays unread can hang.
  const withinLimit = (await readBoundedUtf8(request.clone(), maxBytes)) !== null;
  if (!withinLimit) {
    void request.body.cancel();
  }
  return withinLimit;
}
