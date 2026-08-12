import {
  type CircleSetupAnswers,
  circleSettingsUpdateSchema,
  parseCircleSettingsUpdate,
} from "@pocketcircle/domain";
import type { Mock } from "vitest";
import { vi } from "vitest";
import type { Circle } from "~/lib/data.js";

/** Args the real `updateCircleSettings` mutation accepts (CS-2). */
export type UpdateCircleSettingsArgs = {
  circleId: Circle["id"];
  color?: string;
  setupAnswers?: CircleSetupAnswers;
};

/**
 * Convex mutation double that runs the SAME kind-aware validation as
 * `circles.updateCircleSettings` (parseCircleSettingsUpdate). Use in settings
 * tests so a palette-only server regression fails here, not only in convex-test.
 */
export function makeUpdateCircleSettingsHandler(circle: Circle): Mock {
  return vi.fn((args: UpdateCircleSettingsArgs) => {
    parseCircleSettingsUpdate({ color: args.color, setupAnswers: args.setupAnswers }, circle.kind);
    return Promise.resolve();
  });
}

/**
 * Simulates the pre-fix server that validated color with palette-only
 * `circleSettingsUpdateSchema` — iris on a Personal Circle throws.
 */
export function makePaletteOnlyUpdateCircleSettingsHandler(): Mock {
  return vi.fn((args: UpdateCircleSettingsArgs) => {
    circleSettingsUpdateSchema.parse({ color: args.color, setupAnswers: args.setupAnswers });
    return Promise.resolve();
  });
}
