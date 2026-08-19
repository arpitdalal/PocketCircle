import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { posthogHost, posthogKey } from "./env.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

function builtJs(result: Awaited<ReturnType<typeof build>>) {
  const outputs = Array.isArray(result) ? result : [result];
  const parts: string[] = [];
  for (const output of outputs) {
    if (!("output" in output)) {
      throw new Error("expected a Vite build, not a watcher");
    }
    for (const chunk of output.output) {
      if (chunk.type === "chunk") {
        parts.push(chunk.code);
      }
    }
  }
  return parts.join("\n");
}

describe("posthog env", () => {
  it("reads VITE_POSTHOG_KEY at call time without mocking this module", () => {
    vi.stubEnv("VITE_POSTHOG_KEY", "phc_live");
    expect(posthogKey()).toBe("phc_live");
    vi.stubEnv("VITE_POSTHOG_KEY", "");
    expect(posthogKey()).toBeUndefined();
  });

  it("defaults the ingest host when VITE_POSTHOG_HOST is unset", () => {
    vi.stubEnv("VITE_POSTHOG_HOST", "");
    expect(posthogHost()).toBe("https://us.i.posthog.com");
    vi.stubEnv("VITE_POSTHOG_HOST", "https://eu.i.posthog.com");
    expect(posthogHost()).toBe("https://eu.i.posthog.com");
  });

  it("inlines PostHog key and host in a production Vite build", async () => {
    const previousKey = process.env.VITE_POSTHOG_KEY;
    const previousHost = process.env.VITE_POSTHOG_HOST;
    process.env.VITE_POSTHOG_KEY = "phc_build_assert";
    process.env.VITE_POSTHOG_HOST = "https://eu.i.posthog.com";
    try {
      const result = await build({
        configFile: false,
        logLevel: "silent",
        envDir: await mkdtemp(join(tmpdir(), "pocketcircle-env-")),
        build: {
          write: false,
          minify: false,
          lib: {
            entry: join(import.meta.dirname, "env.ts"),
            name: "env",
            formats: ["es"],
          },
        },
      });
      const code = builtJs(result);
      expect(code).toContain('"phc_build_assert"');
      expect(code).toContain('"https://eu.i.posthog.com"');
      expect(code).not.toContain('import.meta.env["VITE_POSTHOG_KEY"]');
      expect(code).not.toContain("import.meta.env.VITE_POSTHOG_KEY");
    } finally {
      if (previousKey === undefined) {
        delete process.env.VITE_POSTHOG_KEY;
      } else {
        process.env.VITE_POSTHOG_KEY = previousKey;
      }
      if (previousHost === undefined) {
        delete process.env.VITE_POSTHOG_HOST;
      } else {
        process.env.VITE_POSTHOG_HOST = previousHost;
      }
    }
  });
});
