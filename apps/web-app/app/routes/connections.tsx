import { Cable, CircleAlert, LoaderCircle, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Button } from "~/components/ui/button.js";
import { ModalDialog } from "~/components/ui/dialog.js";
import {
  completeMcpConnectionRevocation,
  type McpConnection,
  useMcpConnections,
  useRevokeMcpConnection,
} from "~/lib/data.js";
import { mcpWorkerOrigin } from "~/lib/env.js";
import { mutationErrorMessageForUser } from "~/lib/mutation-user-message.js";
import { useSnackbar } from "~/lib/snackbar.js";

function formatDate(value: number | null) {
  if (value === null) {
    return "Never";
  }
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(value);
}

function connectionTitle(connection: McpConnection) {
  return connection.clientName || connection.clientId;
}

export default function Connections() {
  const connections = useMcpConnections();
  const [selected, setSelected] = useState<McpConnection | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { show } = useSnackbar();
  const revoke = useRevokeMcpConnection();

  async function revokeConnection(connection: McpConnection) {
    if (busyId !== null) {
      return;
    }
    setBusyId(connection.id);
    setError(null);
    let result: Awaited<ReturnType<typeof revoke>>;
    try {
      result = await revoke({ connectionId: connection.id });
    } catch (caught) {
      setError(
        mutationErrorMessageForUser(
          caught,
          "Could not revoke this connection. PocketCircle access was not changed; try again.",
        ),
      );
      setBusyId(null);
      return;
    }
    if (!result.ok) {
      setError("Could not revoke this connection. PocketCircle access was not changed; try again.");
      setBusyId(null);
      return;
    }
    try {
      if (result.value.cleanupToken) {
        const workerOrigin = mcpWorkerOrigin();
        if (!workerOrigin) {
          throw new Error("Authorization server is not configured");
        }
        await completeMcpConnectionRevocation(workerOrigin, result.value.cleanupToken);
      }
      show(
        result.value.cleanupToken || result.value.cleanupStatus !== "pending_revoke"
          ? "Connection revoked."
          : "PocketCircle access revoked; Worker cleanup is pending.",
      );
      setSelected(null);
    } catch (caught) {
      setError(
        mutationErrorMessageForUser(
          caught,
          "PocketCircle access is revoked. Worker cleanup is still pending; try again shortly.",
        ),
      );
      setSelected(null);
    } finally {
      setBusyId(null);
    }
  }

  if (connections.status === "LoadingFirstPage") {
    return <ConnectionsLoading />;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-primary">
          <Cable aria-hidden className="size-5" />
          <span className="text-xs font-semibold uppercase tracking-[0.18em]">Access ledger</span>
        </div>
        <h1 className="font-display text-2xl font-semibold tracking-tight">Connections</h1>
        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
          Review the assistants and tools connected to PocketCircle. Revoking a connection blocks
          PocketCircle access immediately, even while external cleanup finishes.
        </p>
      </div>

      {error ? (
        <div
          role="alert"
          className="flex gap-3 rounded-xl border border-warning/35 bg-warning/10 p-4 text-sm"
        >
          <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
          <p>{error}</p>
        </div>
      ) : null}

      {connections.connections.length === 0 ? (
        <EmptyConnections />
      ) : (
        <section className="space-y-4" aria-label="MCP connections">
          {connections.connections.map((connection) => (
            <ConnectionCard
              key={connection.id}
              connection={connection}
              busy={busyId === connection.id}
              onRevoke={() => setSelected(connection)}
              onRetry={() => void revokeConnection(connection)}
            />
          ))}
          {connections.status === "CanLoadMore" || connections.status === "LoadingMore" ? (
            <Button
              type="button"
              variant="outline"
              onClick={connections.loadMore}
              disabled={connections.status === "LoadingMore"}
            >
              {connections.status === "LoadingMore" ? "Loading…" : "Load older connections"}
            </Button>
          ) : null}
        </section>
      )}

      <ModalDialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open && busyId === null) {
            setSelected(null);
          }
        }}
        title={selected ? `Revoke ${connectionTitle(selected)}?` : "Revoke connection"}
        description="This confirmation applies to the exact client shown below."
      >
        {selected ? (
          <div className="space-y-5">
            <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
              <p className="font-medium">{connectionTitle(selected)}</p>
              <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                {selected.clientId}
              </p>
            </div>
            <p className="text-sm text-muted-foreground">
              This removes the client&apos;s access to {selected.selectedCircles.length} selected
              {selected.selectedCircles.length === 1 ? " Circle" : " Circles"} and any future tool
              calls from this connection.
            </p>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={busyId !== null}
                onClick={() => setSelected(null)}
              >
                Keep connection
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={busyId !== null}
                onClick={() => void revokeConnection(selected)}
              >
                {busyId === selected.id ? "Revoking…" : "Revoke connection"}
              </Button>
            </div>
          </div>
        ) : null}
      </ModalDialog>
    </div>
  );
}

function ConnectionsLoading() {
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div className="space-y-3">
        <span className="block h-3 w-28 animate-pulse-soft rounded bg-muted" />
        <span className="block h-8 w-44 animate-pulse-soft rounded bg-muted" />
        <span className="block h-4 w-full max-w-xl animate-pulse-soft rounded bg-muted" />
      </div>
      <div className="h-48 animate-pulse-soft rounded-xl border border-border bg-card" />
    </div>
  );
}

function EmptyConnections() {
  return (
    <div className="rounded-xl border border-dashed border-border bg-card/60 p-8 text-center">
      <ShieldCheck aria-hidden className="mx-auto size-7 text-primary" />
      <h2 className="mt-4 font-display text-lg font-semibold">No connected clients</h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
        When you approve an MCP client, its access appears here with the Circles and scopes you
        chose.
      </p>
    </div>
  );
}

function ConnectionCard({
  connection,
  busy,
  onRevoke,
  onRetry,
}: {
  connection: McpConnection;
  busy: boolean;
  onRevoke: () => void;
  onRetry: () => void;
}) {
  const revoked = connection.status === "revoked";
  const cleanupPending =
    connection.workerCleanupStatus === "pending_revoke" ||
    connection.workerCleanupStatus === "exhausted";

  return (
    <article className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate font-display text-lg font-semibold">
              {connectionTitle(connection)}
            </h2>
            <span
              className={
                revoked
                  ? "rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                  : "rounded-full bg-primary-soft px-2 py-0.5 text-xs text-primary"
              }
            >
              {revoked ? "Revoked" : connection.status === "pending" ? "Pending" : "Active"}
            </span>
          </div>
          <p className="break-all font-mono text-xs text-muted-foreground">{connection.clientId}</p>
        </div>
        {!revoked ? (
          <Button type="button" variant="destructive" disabled={busy} onClick={onRevoke}>
            {busy ? (
              <>
                <LoaderCircle aria-hidden className="size-4 animate-spin" />
                Revoking…
              </>
            ) : (
              "Revoke"
            )}
          </Button>
        ) : cleanupPending ? (
          <Button type="button" variant="outline" disabled={busy} onClick={onRetry}>
            {busy ? "Retrying…" : "Retry cleanup"}
          </Button>
        ) : null}
      </div>

      <dl className="mt-5 grid gap-4 border-t border-border/70 pt-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">Scopes</dt>
          <dd className="mt-1 flex flex-wrap gap-1.5">
            {connection.scopes.map((scope) => (
              <span key={scope} className="rounded-md bg-muted px-2 py-1 font-mono text-xs">
                {scope}
              </span>
            ))}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Selected Circles</dt>
          <dd className="mt-1 text-foreground">
            {connection.selectedCircles.length > 0
              ? connection.selectedCircles.map((circle) => circle.name).join(", ")
              : "None currently visible"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Created</dt>
          <dd className="mt-1">{formatDate(connection.createdAt)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Last used</dt>
          <dd className="mt-1">{formatDate(connection.lastUsedAt)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Client URI</dt>
          <dd className="mt-1 break-all font-mono text-xs">
            {connection.clientUri || "Not provided"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Redirect URI</dt>
          <dd className="mt-1 break-all font-mono text-xs">{connection.redirectUri}</dd>
        </div>
      </dl>

      {cleanupPending ? (
        <p className="mt-4 border-t border-warning/20 pt-4 text-sm text-warning">
          PocketCircle access is blocked. External cleanup is pending and can be retried.
        </p>
      ) : null}
    </article>
  );
}
