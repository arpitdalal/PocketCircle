import { CircleAlert, LoaderCircle, ShieldCheck } from "lucide-react";
import { useId, useState } from "react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "~/components/ui/accordion.js";
import { Badge } from "~/components/ui/badge.js";
import { Button } from "~/components/ui/button.js";
import { ModalDialog } from "~/components/ui/dialog.js";
import { Field, FieldLabel } from "~/components/ui/field.js";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "~/components/ui/input-group.js";
import {
  completeMcpConnectionRevocation,
  type McpConnection,
  useMcpConnections,
  useRevokeMcpConnection,
} from "~/lib/data.js";
import { mcpServerUrl, mcpWorkerOrigin } from "~/lib/env.js";
import { mutationErrorMessageForUser } from "~/lib/mutation-user-message.js";
import { useSnackbar } from "~/lib/snackbar.js";

const ACCESS_REVOKED_CLEANUP_PENDING =
  "Access is revoked. Finishing with the assistant is still pending — try again shortly.";
const ACCESS_REVOKED_CLEANUP_PENDING_SNACKBAR =
  "Access revoked. Finishing with the assistant is still pending.";
const CLEANUP_PENDING_CARD =
  "Access is already blocked. Finishing with the assistant is still pending.";

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
      const cleanupFinished =
        Boolean(result.value.cleanupToken) || result.value.cleanupStatus === "completed";
      show(cleanupFinished ? "Connection revoked." : ACCESS_REVOKED_CLEANUP_PENDING_SNACKBAR);
      setSelected(null);
    } catch (caught) {
      setError(mutationErrorMessageForUser(caught, ACCESS_REVOKED_CLEANUP_PENDING));
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
        <h1 className="font-display text-2xl font-semibold tracking-tight">Connections</h1>
        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
          Connect AI assistants to Circles you choose, and revoke access anytime.
        </p>
      </div>

      <ConnectAssistantPanel />

      {error ? (
        <div
          role="alert"
          className="flex gap-3 rounded-xl border border-warning/35 bg-warning/10 p-4 text-sm"
        >
          <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
          <p>{error}</p>
        </div>
      ) : null}

      <ConnectionLists
        connections={connections.connections}
        busyId={busyId}
        onRevoke={(connection) => setSelected(connection)}
        onRetry={(connection) => void revokeConnection(connection)}
        canLoadMore={connections.status === "CanLoadMore" || connections.status === "LoadingMore"}
        loadingMore={connections.status === "LoadingMore"}
        onLoadMore={connections.loadMore}
      />

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

function connectionNeedsCleanup(connection: McpConnection) {
  return (
    connection.status === "revoked" &&
    (connection.workerCleanupStatus === "pending_revoke" ||
      connection.workerCleanupStatus === "exhausted")
  );
}

function partitionConnections(connections: readonly McpConnection[]) {
  const actionNeeded: McpConnection[] = [];
  const connected: McpConnection[] = [];
  const revoked: McpConnection[] = [];
  for (const connection of connections) {
    if (connectionNeedsCleanup(connection)) {
      actionNeeded.push(connection);
      continue;
    }
    if (connection.status === "revoked") {
      revoked.push(connection);
      continue;
    }
    connected.push(connection);
  }
  return { actionNeeded, connected, revoked };
}

function ConnectionLists({
  connections,
  busyId,
  onRevoke,
  onRetry,
  canLoadMore,
  loadingMore,
  onLoadMore,
}: {
  connections: readonly McpConnection[];
  busyId: string | null;
  onRevoke: (connection: McpConnection) => void;
  onRetry: (connection: McpConnection) => void;
  canLoadMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const { actionNeeded, connected, revoked } = partitionConnections(connections);
  const showEmpty = actionNeeded.length === 0 && connected.length === 0 && revoked.length === 0;

  return (
    <div className="space-y-8">
      {actionNeeded.length > 0 ? (
        <section className="space-y-4" aria-labelledby="action-needed-heading">
          <div className="space-y-1">
            <h2
              id="action-needed-heading"
              className="font-display text-lg font-semibold tracking-tight"
            >
              Action needed
            </h2>
            <p className="text-sm text-muted-foreground">
              Access is already blocked. Finish cleanup to clear leftover assistant sign-in state.
            </p>
          </div>
          {actionNeeded.map((connection) => (
            <ConnectionCard
              key={connection.id}
              connection={connection}
              busy={busyId === connection.id}
              onRevoke={() => onRevoke(connection)}
              onRetry={() => onRetry(connection)}
            />
          ))}
        </section>
      ) : null}

      {connected.length > 0 ? (
        <section className="space-y-4" aria-labelledby="connected-heading">
          <h2 id="connected-heading" className="font-display text-lg font-semibold tracking-tight">
            Connected
          </h2>
          {connected.map((connection) => (
            <ConnectionCard
              key={connection.id}
              connection={connection}
              busy={busyId === connection.id}
              onRevoke={() => onRevoke(connection)}
              onRetry={() => onRetry(connection)}
            />
          ))}
        </section>
      ) : null}

      {showEmpty ? <EmptyConnections /> : null}

      {revoked.length > 0 ? (
        <Accordion className="rounded-xl border border-border px-4">
          <AccordionItem value="revoked">
            <AccordionTrigger>
              <span className="font-display text-base font-semibold tracking-tight">
                Revoked ({revoked.length})
              </span>
            </AccordionTrigger>
            <AccordionContent className="space-y-4">
              {revoked.map((connection) => (
                <ConnectionCard
                  key={connection.id}
                  connection={connection}
                  busy={busyId === connection.id}
                  onRevoke={() => onRevoke(connection)}
                  onRetry={() => onRetry(connection)}
                />
              ))}
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      ) : null}

      {canLoadMore ? (
        <Button type="button" variant="outline" onClick={onLoadMore} disabled={loadingMore}>
          {loadingMore ? "Loading…" : "Load older connections"}
        </Button>
      ) : null}
    </div>
  );
}

function ConnectAssistantPanel() {
  const serverUrl = mcpServerUrl();
  const urlFieldId = useId();
  const { show } = useSnackbar();
  const [copyBusy, setCopyBusy] = useState(false);

  async function copyUrl() {
    if (!serverUrl || copyBusy) {
      return;
    }
    setCopyBusy(true);
    try {
      await navigator.clipboard.writeText(serverUrl);
      show("MCP server URL copied.");
    } catch {
      show("Couldn't copy. Select the URL and copy it manually.");
    } finally {
      setCopyBusy(false);
    }
  }

  return (
    <section
      className="space-y-5 rounded-xl border border-border bg-card p-5 shadow-sm"
      aria-labelledby="connect-assistant-heading"
    >
      <div className="space-y-1">
        <h2 id="connect-assistant-heading" className="font-display text-lg font-semibold">
          Connect an assistant
        </h2>
        <p className="text-sm leading-6 text-muted-foreground">
          Paste this URL into Claude, Cursor, or another MCP client. You can connect more than one.
        </p>
      </div>

      {serverUrl ? (
        <Field>
          <FieldLabel htmlFor={urlFieldId}>MCP server URL</FieldLabel>
          <InputGroup className="mt-1.5">
            <InputGroupInput
              id={urlFieldId}
              readOnly
              value={serverUrl}
              aria-label="MCP server URL"
              onFocus={(event) => event.currentTarget.select()}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                type="button"
                size="sm"
                disabled={copyBusy}
                aria-label="Copy MCP server URL"
                onClick={() => void copyUrl()}
              >
                {copyBusy ? "Copying…" : "Copy"}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            This address is public. Access starts only after you approve the client and selected
            Circles.
          </p>
        </Field>
      ) : (
        <div
          role="alert"
          className="flex gap-3 rounded-lg border border-warning/35 bg-warning/10 p-3 text-sm"
        >
          <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
          <p>MCP is not configured in this environment, so there is no server URL to copy.</p>
        </div>
      )}

      <ol className="list-decimal space-y-2 pl-5 text-sm leading-6 text-muted-foreground">
        <li>Open your assistant&apos;s MCP or Connectors settings.</li>
        <li>Add a remote MCP server and paste the URL above.</li>
        <li>When PocketCircle opens, sign in with Google if needed.</li>
        <li>Choose Circles and permissions, then Allow.</li>
        <li>The connection appears below. Revoke anytime.</li>
      </ol>
      <p className="text-xs leading-5 text-muted-foreground">
        Never paste API keys or tokens into chat to connect. PocketCircle uses sign-in and approval
        only.
      </p>
    </section>
  );
}

function ConnectionsLoading() {
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div className="space-y-3">
        <span className="block h-8 w-44 animate-pulse-soft rounded bg-muted" />
        <span className="block h-4 w-full max-w-xl animate-pulse-soft rounded bg-muted" />
      </div>
      <div className="h-56 animate-pulse-soft rounded-xl border border-border bg-card" />
      <div className="h-48 animate-pulse-soft rounded-xl border border-border bg-card" />
    </div>
  );
}

function EmptyConnections() {
  return (
    <div className="rounded-xl border border-dashed border-border bg-card/60 p-8 text-center">
      <ShieldCheck aria-hidden className="mx-auto size-7 text-primary" />
      <h2 className="mt-4 font-display text-lg font-semibold">No connected assistants yet</h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
        After you approve a client, it shows up here with the Circles and permissions you chose.
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
  const cleanupPending = connectionNeedsCleanup(connection);
  const statusLabel = revoked
    ? cleanupPending
      ? "Cleanup pending"
      : "Revoked"
    : connection.status === "pending"
      ? "Pending"
      : "Active";

  return (
    <article className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate font-display text-lg font-semibold">
              {connectionTitle(connection)}
            </h2>
            <Badge
              variant={revoked ? "secondary" : connection.status === "pending" ? "outline" : "soft"}
            >
              {statusLabel}
            </Badge>
          </div>
          <p className="break-all font-mono text-xs text-muted-foreground">{connection.clientId}</p>
          {connection.status === "pending" ? (
            <p className="text-xs leading-5 text-muted-foreground">
              Finish connecting in your assistant, or revoke to discard. Unused attempts expire in a
              few minutes.
            </p>
          ) : null}
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
            {busy ? "Retrying…" : "Finish cleanup"}
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
          {CLEANUP_PENDING_CARD}
        </p>
      ) : null}
    </article>
  );
}
