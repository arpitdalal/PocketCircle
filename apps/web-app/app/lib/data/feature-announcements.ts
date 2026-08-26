import { api } from "@pocketcircle/convex";
import { useMutation, useQuery } from "convex/react";
import type { Circle } from "./circles.js";

export function useFeatureAnnouncementSource(circleId: Circle["id"] | undefined, enabled: boolean) {
  return useQuery(
    api.featureAnnouncementSource.getFeatureAnnouncementSource,
    !enabled ? "skip" : circleId !== undefined ? { circleId } : {},
  );
}

export function useAcknowledgeFeatureAnnouncement() {
  return useMutation(api.users.acknowledgeFeatureAnnouncement).withOptimisticUpdate(
    (localStore, args) => {
      const currentUser = localStore.getQuery(api.users.getCurrentUser, {});
      if (currentUser === undefined || currentUser === null) {
        return;
      }
      if (currentUser.acknowledgedFeatureAnnouncementIds.includes(args.announcementId)) {
        return;
      }
      localStore.setQuery(
        api.users.getCurrentUser,
        {},
        {
          ...currentUser,
          acknowledgedFeatureAnnouncementIds: [
            ...currentUser.acknowledgedFeatureAnnouncementIds,
            args.announcementId,
          ],
        },
      );
    },
  );
}
