import { EMAIL_PREVIEWS } from "@pocketcircle/domain";
import { useState } from "react";
import { E2E } from "~/lib/env.js";

export function emailPreviewAllowed(dev: boolean, e2e: boolean) {
  return dev || e2e;
}

export function runEmailPreviewGate(dev: boolean, e2e: boolean) {
  if (!emailPreviewAllowed(dev, e2e)) {
    throw new Response(null, { status: 404 });
  }
}

export async function clientLoader() {
  runEmailPreviewGate(import.meta.env.DEV, E2E);
  return null;
}

function defaultFieldValues(previewId: (typeof EMAIL_PREVIEWS)[number]["id"]) {
  const preview = EMAIL_PREVIEWS.find((entry) => entry.id === previewId) ?? EMAIL_PREVIEWS[0];
  const values: Record<string, string> = {};
  for (const field of preview.fields) {
    values[field.key] = field.default;
  }
  return values;
}

export default function EmailPreviewRoute() {
  const [selectedId, setSelectedId] = useState<(typeof EMAIL_PREVIEWS)[number]["id"]>(
    EMAIL_PREVIEWS[0].id,
  );
  const [values, setValues] = useState<Record<string, string>>(() =>
    defaultFieldValues(EMAIL_PREVIEWS[0].id),
  );

  const preview = EMAIL_PREVIEWS.find((entry) => entry.id === selectedId) ?? EMAIL_PREVIEWS[0];
  const rendered = preview.render(values);

  const selectTemplate = (id: (typeof EMAIL_PREVIEWS)[number]["id"]) => {
    setSelectedId(id);
    setValues(defaultFieldValues(id));
  };

  const updateField = (key: string, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
  };

  return (
    <div className="flex w-full max-w-4xl flex-col gap-6 p-2">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Email preview</h1>
        <p className="text-sm text-muted-foreground">
          Dev-only sample renders of transactional email templates.
        </p>
      </header>

      <div className="flex flex-wrap gap-2">
        {EMAIL_PREVIEWS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={
              entry.id === selectedId
                ? "rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground"
                : "rounded-md border px-3 py-1.5 text-sm"
            }
            onClick={() => selectTemplate(entry.id)}
          >
            {entry.name}
          </button>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <fieldset className="space-y-3 rounded-lg border p-4">
          <legend className="px-1 text-sm font-medium">Sample data</legend>
          {preview.fields.map((field) => (
            <label key={field.key} className="flex flex-col gap-1 text-sm">
              <span>{field.label}</span>
              <input
                className="rounded-md border bg-background px-3 py-2"
                value={values[field.key] ?? ""}
                onChange={(event) => updateField(field.key, event.target.value)}
              />
            </label>
          ))}
        </fieldset>

        <section className="space-y-3 rounded-lg border p-4">
          <div>
            <p className="text-sm font-medium">Subject</p>
            <p className="text-sm text-muted-foreground">{rendered.subject}</p>
          </div>
          <iframe
            title="Email preview"
            className="min-h-80 w-full rounded-md border bg-white"
            srcDoc={rendered.html}
          />
        </section>
      </div>

      {/* TODO(email-preview): capture real sends in a dev-only Convex table when EMAIL_DEV_LOG=1 */}
    </div>
  );
}
