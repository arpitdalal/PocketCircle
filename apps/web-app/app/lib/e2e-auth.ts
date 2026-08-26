import { api } from "@pocketcircle/convex";
import { testId } from "~/test/convex/ids.js";
import { authClient } from "./auth-client.js";
import { convex } from "./convex.js";
import type { Circle, Member } from "./data.js";
import { parseCircleRef } from "./refs.js";

function circleIdFromLocation() {
  const ref = window.location.pathname.match(/\/circles\/([^/]+)/)?.[1];
  const parsed = parseCircleRef(ref);
  if (!parsed) {
    throw new Error("E2E: not on a Circle route");
  }
  return testId<Circle["id"]>(parsed.id);
}

function memberIdFromString(memberId: string) {
  if (!/^[a-z0-9]+$/i.test(memberId)) {
    throw new Error("E2E removeMember: invalid member id");
  }
  return testId<Member["id"]>(memberId);
}

/**
 * E2E-only test-auth helper (ADR 0019). Exposes a tiny `window.__scE2E` so the
 * Playwright global-setup can establish a REAL Better Auth session via the
 * flag-gated email+password path — without driving Google OAuth, which Playwright
 * can't automate. The client persists the session in its own storage, which
 * Playwright then captures as `storageState`.
 *
 * This whole module is imported only behind `VITE_E2E` (see entry.client.tsx), so
 * the production bundle eliminates it entirely. Production stays Google-only.
 */
export function installE2EAuthHelper(): void {
  Object.assign(window as object, {
    __scE2E: {
      /**
       * Sign up (first run for a unique email) then sign in. Sign-up triggers the
       * backend `onCreateUser` → the User + their Personal Circle, so the
       * authenticated app immediately has real data to render. Completes USR-1
       * onboarding so the protected shell is reachable without driving the form.
       */
      async signIn(email: string, password: string, name = "E2E Tester") {
        await authClient.signUp.email({ email, password, name }).catch(() => {
          // Already exists (re-run with same email) — fall through to sign-in.
        });
        await authClient.signIn.email({ email, password });

        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          try {
            // react-doctor-disable-next-line react-doctor/async-await-in-loop -- retry/poll loop; each await depends on the prior attempt's outcome (the backend trigger may not have run yet), so iterations are inherently sequential — Promise.all doesn't apply.
            await convex.mutation(api.users.completeOnboarding, { displayName: name });
            return;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // react-doctor-disable-next-line react-doctor/js-set-map-lookups -- String.prototype.includes (substring match on an error message), not Array membership; a Set can't model substring search.
            if (message.includes("Onboarding already completed")) {
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        }
        throw new Error("E2E sign-in: onboarding completion timed out");
      },

      /** Seeds an active Member on the current Circle route (MEM-5 E2E until MEM-3). */
      async seedActiveMember(email: string, displayName: string) {
        return convex.mutation(api.e2e.seedActiveMember, {
          circleId: circleIdFromLocation(),
          email,
          displayName,
        });
      },

      /** Calls removeMember for the current Circle route (permission probes). */
      async removeMember(memberId: string) {
        return convex.mutation(api.members.removeMember, {
          circleId: circleIdFromLocation(),
          memberId: memberIdFromString(memberId),
        });
      },
      /** Marks a non-owner Member removed (MEM-3 rejoin E2E until MEM-5 ships). */
      async markMemberRemoved(circleId: Circle["id"], memberId: Member["id"]) {
        await convex.mutation(api.e2eTesting.markMemberRemovedForE2E, {
          circleId,
          memberId,
        });
      },
      async listMembers(circleId: Circle["id"]) {
        return await convex.query(api.members.listMembers, {
          circleId,
        });
      },
      /** Accept a pending invitation by token (E2E-only backend; MEM-3 will replace this). */
      async acceptInvitation(token: string) {
        await convex.mutation(api.e2e.acceptInvitationForE2E, { token });
      },

      /**
       * Poll for the last emailed invitation token on the current Circle (EML-2).
       * The Members UI no longer exposes copyable links; E2E reads from the
       * flag-gated backend stash populated by `sendInvitationEmail`.
       */
      async getInvitationToken(email: string) {
        const circleId = circleIdFromLocation();
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          const token = await convex.query(api.e2e.getInvitationTokenForE2E, {
            circleId,
            email,
          });
          if (token) {
            return token;
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        throw new Error("E2E: invitation token not available");
      },

      /** Poll for the Account Deletion verification token (USR-3). */
      async getAccountDeletionToken() {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          const token = await convex.query(api.e2e.getAccountDeletionTokenForE2E, {});
          if (token) {
            return token;
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        throw new Error("E2E: account deletion token not available");
      },

      /** Session probe for post-deletion assertions (USR-3). */
      async getSession() {
        const result = await authClient.getSession();
        return result.data?.session ?? null;
      },

      /**
       * Backdate the signed-in User's `createdAt` for Feature Announcement E2E
       * (#282) so eligibility survives release-prep cutoff replacement.
       */
      async backdateCreatedAt(createdAt: number) {
        await convex.mutation(api.e2e.backdateCurrentUserCreatedAtForE2E, { createdAt });
      },
    },
  });
}
