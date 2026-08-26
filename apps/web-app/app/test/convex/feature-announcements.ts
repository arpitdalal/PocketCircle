import { api } from "@pocketcircle/convex";
import { getFunctionName } from "convex/server";
import type { EntityDouble } from "./contract.js";
import { resolveWith } from "./contract.js";

export interface FeatureAnnouncementSourceView {
  circleRef: string;
  transactionRef: string;
}

export interface FeatureAnnouncementsState {
  featureAnnouncementSource?:
    | FeatureAnnouncementSourceView
    | null
    | ((args: Record<string, unknown>) => FeatureAnnouncementSourceView | null | undefined);
}

export function featureAnnouncementsDouble(state: FeatureAnnouncementsState): EntityDouble {
  const { featureAnnouncementSource } = state;
  return {
    queries: {
      ...(featureAnnouncementSource !== undefined
        ? {
            [getFunctionName(api.featureAnnouncementSource.getFeatureAnnouncementSource)]: (args) =>
              resolveWith(featureAnnouncementSource, args),
          }
        : {}),
    },
    mutations: {},
  };
}
