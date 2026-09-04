/**
 * Browser Origin checks for MCP Worker consent / revoke endpoints.
 * Loopback hostnames are interchangeable when APP_ORIGIN is also loopback
 * (Vite may serve `localhost` while .dev.vars pins `127.0.0.1`).
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isLoopbackHostname(hostname: string) {
  return LOOPBACK_HOSTS.has(hostname);
}

export function browserOriginAllowed(requestOrigin: string | null, appOrigin: string) {
  if (!requestOrigin) {
    return false;
  }
  if (requestOrigin === appOrigin) {
    return true;
  }
  try {
    const request = new URL(requestOrigin);
    const app = new URL(appOrigin);
    if (request.protocol !== app.protocol || request.port !== app.port) {
      return false;
    }
    return isLoopbackHostname(request.hostname) && isLoopbackHostname(app.hostname);
  } catch {
    return false;
  }
}
