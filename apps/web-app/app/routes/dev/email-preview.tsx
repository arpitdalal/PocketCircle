import { EMAIL_BRAND, EMAIL_PREVIEWS } from "@pocketcircle/domain";
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
  const origin = window.location.origin;
  const values: Record<string, string> = {};
  for (const field of preview.fields) {
    if (field.key === "appVersion") {
      values[field.key] = __APP_VERSION__;
    } else if (field.key === "appUrl") {
      values[field.key] = origin;
    } else if (field.key === "inviteLink") {
      values[field.key] = `${origin}/invite/sample-token`;
    } else if (field.key === "verifyLink") {
      values[field.key] = `${origin}/delete-account/verify?token=sample-token`;
    } else {
      values[field.key] = field.default;
    }
  }
  return values;
}

const PREVIEW_WIDTHS = [
  { id: "desktop", label: "Desktop", className: "max-w-[600px]" },
  { id: "mobile", label: "Mobile", className: "max-w-[375px]" },
] as const;

export default function EmailPreviewRoute() {
  const [selectedId, setSelectedId] = useState<(typeof EMAIL_PREVIEWS)[number]["id"]>(
    EMAIL_PREVIEWS[0].id,
  );
  const [values, setValues] = useState<Record<string, string>>(() =>
    defaultFieldValues(EMAIL_PREVIEWS[0].id),
  );
  const [widthId, setWidthId] = useState<(typeof PREVIEW_WIDTHS)[number]["id"]>("desktop");

  const preview = EMAIL_PREVIEWS.find((entry) => entry.id === selectedId) ?? EMAIL_PREVIEWS[0];
  const rendered = preview.render(values);
  const width = PREVIEW_WIDTHS.find((entry) => entry.id === widthId) ?? PREVIEW_WIDTHS[0];

  const selectTemplate = (id: (typeof EMAIL_PREVIEWS)[number]["id"]) => {
    setSelectedId(id);
    setValues(defaultFieldValues(id));
  };

  const updateField = (key: string, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
  };

  return (
    <div className="flex w-full max-w-5xl flex-col gap-6 p-2">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Email preview</h1>
        <p className="text-sm text-muted-foreground">
          Dev-only sample renders of transactional email templates. Open at{" "}
          <code className="text-xs">/dev/email-preview</code> while running{" "}
          <code className="text-xs">pnpm dev</code>.
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

      <div className="grid gap-4 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
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
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Subject</p>
              <p className="text-sm text-muted-foreground">{rendered.subject}</p>
            </div>
            <div className="flex gap-1">
              {PREVIEW_WIDTHS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={
                    entry.id === widthId
                      ? "rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground"
                      : "rounded-md border px-2.5 py-1 text-xs"
                  }
                  onClick={() => setWidthId(entry.id)}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          </div>
          <div className="rounded-md border p-3" style={{ backgroundColor: EMAIL_BRAND.canvas }}>
            <iframe
              title="Email preview"
              className={`min-h-[32rem] w-full rounded-md border-0 bg-white ${width.className}`}
              srcDoc={rendered.html}
            />
          </div>
        </section>
      </div>
    </div>
  );
}
