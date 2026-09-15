import { api } from "@pocketcircle/convex";
import { useMutation } from "convex/react";

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
