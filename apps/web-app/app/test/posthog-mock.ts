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

export function resetPostHogSdkMocks() {
  vi.clearAllMocks();
}
