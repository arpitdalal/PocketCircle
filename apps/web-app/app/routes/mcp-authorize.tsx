import { MUTATION_ERRORS } from "@pocketcircle/domain";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { SkeletonRegion } from "~/components/skeleton.js";
import { Button } from "~/components/ui/button.js";
import {
  type Circle,
  type McpHandoffView,
  useApproveMcpAuthorization,
  useMcpHandoff,
  useMyCircles,
} from "~/lib/data.js";
import { mcpWorkerOrigin } from "~/lib/env.js";
import { mutationErrorMessageForUser } from "~/lib/mutation-user-message.js";

/**
 * MCP OAuth consent (#318). Protected layout already enforced Google session +
 * onboarding. Shows Worker-signed handoff fields (client label only — not proof
 * of identity), requested scopes, refresh duration, and Circles the User may
 * select. Approval token returns to the Worker via POST body, never a URL.
 */
export default function McpAuthorize() {
  const [params] = useSearchParams();
  const handoff = params.get("handoff");
  const view = useMcpHandoff(handoff);

  if (!handoff) {
    return <ConsentInvalid />;
  }
  if (view === undefined) {
    return <ConsentLoading />;
  }
  if (view === null) {
    return <ConsentInvalid />;
  }

  return <ConsentForm handoff={handoff} view={view} />;
}

function ConsentLoading() {
  return (
    <div className="mx-auto max-w-lg space-y-6">
      <h1 className="font-display text-2xl font-semibold tracking-tight">Authorize access</h1>
      <SkeletonRegion label="Loading authorization request" testId="mcp-authorize-skeleton">
        <div className="space-y-3">
          <span className="block h-4 w-48 animate-pulse-soft rounded-md bg-muted" />
          <span className="block h-3 w-64 animate-pulse-soft rounded-md bg-muted" />
          <span className="block h-24 w-full animate-pulse-soft rounded-md bg-muted" />
        </div>
      </SkeletonRegion>
    </div>
  );
}

function ConsentInvalid() {
  return (
    <div className="mx-auto max-w-lg space-y-4">
      <h1 className="font-display text-2xl font-semibold tracking-tight">Authorize access</h1>
      <p role="alert" className="text-sm text-muted-foreground">
        {MUTATION_ERRORS.mcpHandoffInvalid.message}
      </p>
    </div>
  );
}

function scopeLabel(scope: string) {
  if (scope === "pocketcircle:read") {
    return "Read your Circles, Transactions, Categories, and reports";
  }
  if (scope === "pocketcircle:write") {
    return "Create and edit Transactions and Categories";
  }
  return scope;
}

function ConsentForm({ handoff, view }: { handoff: string; view: McpHandoffView }) {
  const circles = useMyCircles();
  const approve = useApproveMcpAuthorization();
  const workerOrigin = mcpWorkerOrigin();

  const [selectedCircleIds, setSelectedCircleIds] = useState<string[]>([]);
  const [grantedScopes, setGrantedScopes] = useState(() => [...view.scopes]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleCircle(id: string) {
    setSelectedCircleIds((current) =>
      current.includes(id) ? current.filter((c) => c !== id) : [...current, id],
    );
  }

  function toggleScope(scope: string) {
    setGrantedScopes((current) =>
      current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope],
    );
  }

  async function handleDeny() {
    if (submitting || !workerOrigin) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(new URL("/authorize/deny", workerOrigin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handoffId: view.handoffId }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (
        !response.ok ||
        typeof payload !== "object" ||
        payload === null ||
        !("redirectTo" in payload) ||
        typeof payload.redirectTo !== "string"
      ) {
        setError("Couldn't deny the request. Try again.");
        return;
      }
      window.location.assign(payload.redirectTo);
    } catch {
      setError("Couldn't reach the authorization server.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleApprove() {
    if (
      submitting ||
      !workerOrigin ||
      selectedCircleIds.length === 0 ||
      grantedScopes.length === 0
    ) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const { approvalToken } = await approve({
        handoff,
        selectedCircleIds,
        grantedScopes,
      });
      const response = await fetch(new URL("/authorize/complete", workerOrigin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approvalToken }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (
        !response.ok ||
        typeof payload !== "object" ||
        payload === null ||
        !("redirectTo" in payload) ||
        typeof payload.redirectTo !== "string"
      ) {
        setError("Couldn't finish authorization. Ask the app to connect again.");
        return;
      }
      window.location.assign(payload.redirectTo);
    } catch (caught) {
      setError(mutationErrorMessageForUser(caught, "Couldn't approve this request"));
    } finally {
      setSubmitting(false);
    }
  }

  const clientTitle = view.clientName?.trim() || view.clientId;
  const canApprove =
    Boolean(workerOrigin) &&
    selectedCircleIds.length > 0 &&
    grantedScopes.length > 0 &&
    !submitting;

  return (
    <div className="mx-auto max-w-lg space-y-8">
      <div className="space-y-2">
        <h1 className="font-display text-2xl font-semibold tracking-tight">Authorize access</h1>
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{clientTitle}</span> wants to access
          PocketCircle on your behalf. Client names and logos are provided by the app and are not
          proof of identity — check the client ID below.
        </p>
      </div>

      <section className="space-y-3 rounded-xl border border-border bg-card p-5 shadow-sm">
        <h2 className="text-sm font-medium">Requesting app</h2>
        <dl className="space-y-2 text-sm">
          <div>
            <dt className="text-muted-foreground">Client ID</dt>
            <dd className="break-all font-mono text-xs">{view.clientId}</dd>
          </div>
          {view.clientUri ? (
            <div>
              <dt className="text-muted-foreground">Homepage</dt>
              <dd className="break-all">{view.clientUri}</dd>
            </div>
          ) : null}
          {view.logoUri ? (
            <div>
              <dt className="text-muted-foreground">Logo</dt>
              <dd>
                <img
                  src={view.logoUri}
                  alt=""
                  className="mt-1 size-10 rounded-md border border-border object-contain"
                />
              </dd>
            </div>
          ) : null}
          <div>
            <dt className="text-muted-foreground">Redirect</dt>
            <dd className="break-all font-mono text-xs">{view.redirectUri}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Resource</dt>
            <dd className="break-all font-mono text-xs">{view.resource}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Refresh token lifetime</dt>
            <dd>{view.refreshDurationLabel}</dd>
          </div>
        </dl>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Permissions</h2>
        <ul className="space-y-2">
          {view.scopes.map((scope) => (
            <li key={scope}>
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={grantedScopes.includes(scope)}
                  onChange={() => toggleScope(scope)}
                  className="mt-0.5 size-4 shrink-0 rounded border border-input accent-primary"
                />
                <span>
                  <span className="font-medium">{scope}</span>
                  <span className="mt-0.5 block text-muted-foreground">{scopeLabel(scope)}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Circles</h2>
        <p className="text-sm text-muted-foreground">
          Choose which Circles this app may access. New Circles you join later are not included
          automatically.
        </p>
        {circles === undefined ? (
          <SkeletonRegion label="Loading Circles" testId="mcp-circles-skeleton">
            <span className="block h-16 w-full animate-pulse-soft rounded-md bg-muted" />
          </SkeletonRegion>
        ) : circles.length === 0 ? (
          <p className="text-sm text-muted-foreground">You have no Circles to authorize.</p>
        ) : (
          <ul className="space-y-2">
            {circles.map((circle: Circle) => (
              <li key={circle.id}>
                <label className="flex items-center gap-3 rounded-lg border border-border/60 px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selectedCircleIds.includes(circle.id)}
                    onChange={() => toggleCircle(circle.id)}
                    className="size-4 shrink-0 rounded border border-input accent-primary"
                  />
                  <span className="font-medium">{circle.name}</span>
                  <span className="text-muted-foreground">({circle.kind})</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </section>

      {!workerOrigin ? (
        <p role="alert" className="text-sm text-destructive">
          Authorization server is not configured (missing VITE_MCP_WORKER_ORIGIN).
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <Button type="button" disabled={!canApprove} onClick={() => void handleApprove()}>
          {submitting ? "Working…" : "Approve"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={submitting || !workerOrigin}
          onClick={() => void handleDeny()}
        >
          Deny
        </Button>
      </div>
    </div>
  );
}
