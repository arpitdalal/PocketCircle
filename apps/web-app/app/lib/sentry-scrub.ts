import type * as Sentry from "@sentry/react";
import type { Breadcrumb } from "@sentry/react";
import { redactRefForTelemetry } from "./refs.js";

type BeforeSendEvent = Parameters<
  NonNullable<NonNullable<Parameters<typeof Sentry.init>[0]>["beforeSend"]>
>[0];

const FINANCIAL_EXTRA_KEYS = new Set([
  "amount",
  "amountMinorUnits",
  "feedback",
  "feedbackText",
  "note",
  "title",
]);

const URL_DATA_KEYS = new Set(["from", "to", "url"]);

/** Query params that carry user-entered or financial data — omit from telemetry. */
const DROP_QUERY_PARAMS = new Set(["q", "min", "max", "handoff"]);

/** Query params whose values are in-app paths/URLs and must be recursively scrubbed. */
const URL_QUERY_PARAMS = new Set(["returnTo"]);

/** Query params whose values are slug-id refs. */
const REF_QUERY_PARAMS = new Set(["categoryRef"]);

/** Query params whose values are comma-separated slug-id refs. */
const REF_LIST_QUERY_PARAMS = new Set(["categories", "recordedBy", "paidBy"]);

function scrubPathSegment(segment: string) {
  if (!segment) {
    return segment;
  }
  return redactRefForTelemetry(segment);
}

function scrubRefList(value: string) {
  return value
    .split(",")
    .map((part) => redactRefForTelemetry(part.trim()))
    .join(",");
}

function scrubQueryParamValue(key: string, value: string) {
  if (DROP_QUERY_PARAMS.has(key)) {
    return null;
  }
  if (URL_QUERY_PARAMS.has(key) || value.startsWith("/")) {
    return scrubUrlForSentry(value);
  }
  if (REF_QUERY_PARAMS.has(key)) {
    return redactRefForTelemetry(value);
  }
  if (REF_LIST_QUERY_PARAMS.has(key)) {
    return scrubRefList(value);
  }
  return value;
}

function scrubUrlSearchForSentry(search: string) {
  if (!search) {
    return "";
  }
  const raw = search.startsWith("?") ? search.slice(1) : search;
  if (!raw) {
    return "";
  }
  const params = new URLSearchParams(raw);
  const scrubbed = new URLSearchParams();
  for (const [key, value] of params) {
    const next = scrubQueryParamValue(key, value);
    if (next !== null && next !== "") {
      scrubbed.append(key, next);
    }
  }
  const query = scrubbed.toString();
  return query ? `?${query}` : "";
}

/** Scrub title/name slugs from each path segment of a URL string. */
export function scrubUrlForSentry(urlString: string) {
  try {
    const url = new URL(urlString, "http://localhost");
    url.pathname = url.pathname
      .split("/")
      .map((segment) => scrubPathSegment(segment))
      .join("/");
    const scrubbedSearch = scrubUrlSearchForSentry(url.search);
    if (url.origin === "http://localhost") {
      return `${url.pathname}${scrubbedSearch}`;
    }
    url.search = scrubbedSearch.startsWith("?") ? scrubbedSearch.slice(1) : "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[scrubbed-url]";
  }
}

function scrubStringForKey(key: string | undefined, value: string) {
  if (key && URL_DATA_KEYS.has(key)) {
    return scrubUrlForSentry(value);
  }
  if (key === "rawRef") {
    return redactRefForTelemetry(value);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scrubUnknownValue(value: unknown, key?: string): unknown {
  if (typeof value === "string") {
    return scrubStringForKey(key, value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => scrubUnknownValue(entry));
  }
  if (isRecord(value)) {
    return scrubRecord(value);
  }
  return value;
}

function scrubRecord(record: Record<string, unknown>) {
  const scrubbed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (FINANCIAL_EXTRA_KEYS.has(key)) {
      continue;
    }
    scrubbed[key] = scrubUnknownValue(value, key);
  }
  return scrubbed;
}

/** Scrub `reportAppError` extras before Sentry capture. Dev console keeps the raw context. */
export function scrubAppErrorExtra(context?: Record<string, unknown>) {
  if (!context) {
    return undefined;
  }
  return scrubRecord(context);
}

function scrubBreadcrumbData(data: Record<string, unknown>) {
  return scrubRecord(data);
}

/** Strip title-bearing refs and financial fields from a Sentry event before send. */
export function scrubSentryEvent(event: BeforeSendEvent) {
  if (event.request?.url) {
    event.request.url = scrubUrlForSentry(event.request.url);
  }

  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((breadcrumb) => {
      if (!breadcrumb.data) {
        return breadcrumb;
      }
      return {
        ...breadcrumb,
        data: scrubBreadcrumbData(breadcrumb.data),
      };
    });
  }

  if (event.extra) {
    event.extra = scrubRecord(event.extra);
  }

  if (event.tags) {
    for (const [key, value] of Object.entries(event.tags)) {
      if (FINANCIAL_EXTRA_KEYS.has(key)) {
        delete event.tags[key];
        continue;
      }
      if (typeof value === "string") {
        event.tags[key] = scrubStringForKey(key, value);
      }
    }
  }

  if (event.contexts) {
    for (const [name, context] of Object.entries(event.contexts)) {
      if (!isRecord(context)) {
        continue;
      }
      event.contexts[name] = scrubRecord({ ...context });
    }
  }

  return event;
}

export function scrubSentryBreadcrumb(breadcrumb: Breadcrumb) {
  if (!breadcrumb.data) {
    return breadcrumb;
  }
  return {
    ...breadcrumb,
    data: scrubBreadcrumbData(breadcrumb.data),
  };
}
