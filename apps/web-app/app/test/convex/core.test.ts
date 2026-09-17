import { api } from "@pocketcircle/convex";
import { describe, expect, it, vi } from "vitest";
import {
  configureConvex,
  convexReactMock,
  makeCircleView,
  makeCurrentUserView,
  type OptimisticLocalStore,
} from "~/test/convex-react.js";
import { deferredMutationFn } from "~/test/deferred.js";

/**
 * The harness's own contract, where it models the Convex client rather than a backend
 * function: optimistic writes are layered per in-flight mutation, so one mutation's
 * rollback can never discard another's guess. Component tests inherit this silently —
 * a shared override map would make two overlapping mutations flake by ordering alone.
 */
describe("configureConvex optimistic writes", () => {
  it("rolls back only the failed mutation, keeping a concurrent mutation's write", async () => {
    const user = makeCurrentUserView({ displayName: "Server name" });
    const slowAck = deferredMutationFn<null>();
    configureConvex({
      currentUser: user,
      circles: [makeCircleView({ ref: "trip-c1", name: "Server circle" })],
      acknowledgeFeatureAnnouncement: slowAck.fn,
      updateProfile: vi.fn(async () => {
        throw new Error("updateProfile rejected");
      }),
    });
    const convex = convexReactMock.useConvex();

    const ack = convexReactMock
      .useMutation(api.users.acknowledgeFeatureAnnouncement)
      .withOptimisticUpdate((localStore: OptimisticLocalStore) => {
        localStore.setQuery(api.users.getCurrentUser, {}, { ...user, displayName: "Guessed name" });
      });
    const updateProfile = convexReactMock
      .useMutation(api.users.updateProfile)
      .withOptimisticUpdate((localStore: OptimisticLocalStore) => {
        localStore.setQuery(api.circles.listMyCircles, {}, []);
      });

    const ackPending = ack({ announcementId: "a1" });
    expect(await convex.query(api.users.getCurrentUser, {})).toMatchObject({
      displayName: "Guessed name",
    });

    await expect(updateProfile({ displayName: "Nope" })).rejects.toThrow("updateProfile rejected");

    // The rejected mutation's guess is gone; the still-pending one's survives.
    expect(await convex.query(api.circles.listMyCircles, {})).toHaveLength(1);
    expect(await convex.query(api.users.getCurrentUser, {})).toMatchObject({
      displayName: "Guessed name",
    });

    slowAck.resolve(null);
    await ackPending;
    expect(await convex.query(api.users.getCurrentUser, {})).toMatchObject({
      displayName: "Guessed name",
    });
  });
});
