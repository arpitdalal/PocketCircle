import { createContext, type ReactNode, use } from "react";
import { type ActivationChecklist, useActivationChecklist } from "~/lib/data.js";

/**
 * One owner for the Activation Checklist subscription in the authenticated shell
 * (issue #351). Both presentations are mounted at once — the Home card below `lg`, the
 * sidebar launcher at `lg` and above — and the hook carries side effects: it initializes
 * the row for existing Users and claims completion analytics. Two subscribers meant two
 * of each mutation, absorbed only by backend idempotence.
 *
 * The shell mounts this once; the card and the launcher read the value.
 */

const MISSING_PROVIDER = "missing-activation-checklist-provider";

const ActivationChecklistContext = createContext<
  ActivationChecklist | undefined | typeof MISSING_PROVIDER
>(MISSING_PROVIDER);

export function ActivationChecklistProvider({ children }: { children: ReactNode }) {
  const checklist = useActivationChecklist();
  return <ActivationChecklistContext value={checklist}>{children}</ActivationChecklistContext>;
}

export function useActivationChecklistValue() {
  const checklist = use(ActivationChecklistContext);
  if (checklist === MISSING_PROVIDER) {
    throw new Error("Activation Checklist presentations require <ActivationChecklistProvider>");
  }
  return checklist;
}
