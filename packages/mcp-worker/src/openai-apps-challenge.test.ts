import { env, SELF } from "cloudflare:test";
import { MCP_ORIGIN } from "@pocketcircle/domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  OPENAI_APPS_CHALLENGE_PATH,
  openaiAppsChallengeResponse,
} from "./openai-apps-challenge.js";

afterEach(() => {
  delete env.OPENAI_APPS_CHALLENGE_TOKEN;
});

describe("openaiAppsChallengeResponse", () => {
  it("returns only the trimmed token as text/plain", async () => {
    const response = openaiAppsChallengeResponse("  token-value  ");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe("token-value");
  });

  it("returns 404 when the token is unset or blank", async () => {
    expect(openaiAppsChallengeResponse(undefined).status).toBe(404);
    expect(openaiAppsChallengeResponse("   ").status).toBe(404);
  });
});

describe("GET /.well-known/openai-apps-challenge", () => {
  const challengeUrl = `${MCP_ORIGIN}${OPENAI_APPS_CHALLENGE_PATH}`;

  it("serves the Worker secret when set", async () => {
    env.OPENAI_APPS_CHALLENGE_TOKEN = "portal-challenge-token";
    const response = await SELF.fetch(challengeUrl);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("portal-challenge-token");
  });

  it("returns 404 when the secret is absent", async () => {
    const response = await SELF.fetch(challengeUrl);
    expect(response.status).toBe(404);
  });
});
