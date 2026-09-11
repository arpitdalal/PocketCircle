import { api } from "@pocketcircle/convex";
import { getFunctionName } from "convex/server";
import type { Mock } from "vitest";
import type { EntityDouble } from "./contract.js";
import { resolveWith } from "./contract.js";

export type PushVapidPublicKey = { publicKey: string; keyId: string } | null;

export interface PushSubscriptionsState {
  pushVapidPublicKey?:
    | PushVapidPublicKey
    | ((args: Record<string, unknown>) => PushVapidPublicKey | undefined);
  enablePushSubscription?: Mock;
  disablePushSubscription?: Mock;
  reconcilePushSubscription?: Mock;
}

export function pushSubscriptionsDouble(state: PushSubscriptionsState): EntityDouble {
  const {
    pushVapidPublicKey,
    enablePushSubscription,
    disablePushSubscription,
    reconcilePushSubscription,
  } = state;
  return {
    queries: {
      [getFunctionName(api.pushSubscriptions.getPushVapidPublicKey)]: (args) =>
        pushVapidPublicKey === undefined ? null : resolveWith(pushVapidPublicKey, args),
    },
    mutations: {
      [getFunctionName(api.pushSubscriptions.enablePushSubscription)]: enablePushSubscription,
      [getFunctionName(api.pushSubscriptions.disablePushSubscription)]: disablePushSubscription,
      [getFunctionName(api.pushSubscriptions.reconcilePushSubscription)]: reconcilePushSubscription,
    },
  };
}
