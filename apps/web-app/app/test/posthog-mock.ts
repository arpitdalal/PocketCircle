import { vi } from "vitest";

export const posthogSdk = {
  init: vi.fn(),
  capture: vi.fn(),
  opt_out_capturing: vi.fn(),
  opt_in_capturing: vi.fn(),
  stopSessionRecording: vi.fn(),
  reset: vi.fn(),
};

export const posthogModuleMock = {
  default: posthogSdk,
};

export const posthogEnv: { POSTHOG_KEY: string | undefined; POSTHOG_HOST: string } = {
  POSTHOG_KEY: "phc_test",
  POSTHOG_HOST: "https://us.i.posthog.com",
};

export async function createPosthogEnvMock(importOriginal: <T>() => Promise<T>) {
  const actual = await importOriginal<typeof import("../lib/env.js")>();
  return {
    ...actual,
    posthogKey() {
      return posthogEnv.POSTHOG_KEY;
    },
    posthogHost() {
      return posthogEnv.POSTHOG_HOST;
    },
  };
}

export function resetPostHogSdkMocks() {
  vi.clearAllMocks();
  posthogEnv.POSTHOG_KEY = "phc_test";
  posthogEnv.POSTHOG_HOST = "https://us.i.posthog.com";
}
