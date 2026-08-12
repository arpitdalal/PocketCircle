import { type CurrencyCode, type FeedbackType, isSupportedCurrency } from "@pocketcircle/domain";

import type { LifecycleFilter, TypeFilter } from "./transaction-filter-url.js";

/** Transaction / ledger filter type values allowed in analytics payloads. */
export type AnalyticsTransactionType = TypeFilter;

/** Lifecycle filter values allowed in analytics payloads. */
export type AnalyticsLifecycleStatus = LifecycleFilter;

export type AnalyticsCategorySource = "standalone" | "transaction_inline";

export type AnalyticsExportResult = "downloaded" | "too_many" | "inaccessible" | "failed";

export type AnalyticsFeedbackType = FeedbackType;

export type AnalyticsCategoryType = Extract<AnalyticsTransactionType, "expense" | "income">;

export const FORBIDDEN_ANALYTICS_PROP_KEYS = [
  "amount",
  "amountMinorUnits",
  "min",
  "max",
  "title",
  "note",
  "message",
  "feedback",
  "feedbackText",
  "query",
  "q",
  "search",
  "email",
  "displayName",
  "name",
  "circleName",
  "categoryName",
  "memberName",
  "id",
  "ids",
  "circleId",
  "categoryId",
  "memberId",
  "transactionId",
  "ref",
  "url",
  "returnTo",
] as const;

const FORBIDDEN_KEY_SET = new Set<string>(FORBIDDEN_ANALYTICS_PROP_KEYS);

export type AnalyticsEventMap = {
  circle_created: { currency: CurrencyCode };
  transaction_added: {
    type: AnalyticsTransactionType;
    paidBySelf: boolean;
    categoryCount: number;
  };
  category_created: {
    type: AnalyticsCategoryType;
    source: AnalyticsCategorySource;
  };
  ledger_filter_applied: {
    type: AnalyticsTransactionType;
    status: AnalyticsLifecycleStatus;
    hasQuery: boolean;
    categoryCount: number;
    recordedByCount: number;
    paidByCount: number;
    monthOffset: number;
  };
  transaction_search_submitted: {
    type: AnalyticsTransactionType;
    status: AnalyticsLifecycleStatus;
    hasQuery: boolean;
    hasDateRange: boolean;
    hasAmountRange: boolean;
    categoryCount: number;
    recordedByCount: number;
    paidByCount: number;
  };
  transaction_search_page_changed: { page: number };
  export_performed: {
    status: AnalyticsLifecycleStatus;
    result: AnalyticsExportResult;
    hasQuery: boolean;
    hasDateRange: boolean;
    hasAmountRange: boolean;
  };
  feedback_submitted: { type: AnalyticsFeedbackType };
};

export type AnalyticsEvent = keyof AnalyticsEventMap;

const EVENT_ALLOWLISTS: Record<AnalyticsEvent, ReadonlySet<string>> = {
  circle_created: new Set(["currency"]),
  transaction_added: new Set(["type", "paidBySelf", "categoryCount"]),
  category_created: new Set(["type", "source"]),
  ledger_filter_applied: new Set([
    "type",
    "status",
    "hasQuery",
    "categoryCount",
    "recordedByCount",
    "paidByCount",
    "monthOffset",
  ]),
  transaction_search_submitted: new Set([
    "type",
    "status",
    "hasQuery",
    "hasDateRange",
    "hasAmountRange",
    "categoryCount",
    "recordedByCount",
    "paidByCount",
  ]),
  transaction_search_page_changed: new Set(["page"]),
  export_performed: new Set(["status", "result", "hasQuery", "hasDateRange", "hasAmountRange"]),
  feedback_submitted: new Set(["type"]),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasForbiddenKey(key: string) {
  return FORBIDDEN_KEY_SET.has(key);
}

function isAnalyticsTransactionType(value: unknown): value is AnalyticsTransactionType {
  return value === "expense" || value === "income" || value === "all";
}

function isAnalyticsCategoryType(value: unknown): value is AnalyticsCategoryType {
  return value === "expense" || value === "income";
}

function isAnalyticsLifecycleStatus(value: unknown): value is AnalyticsLifecycleStatus {
  return value === "active" || value === "archived" || value === "all";
}

function isAnalyticsCategorySource(value: unknown): value is AnalyticsCategorySource {
  return value === "standalone" || value === "transaction_inline";
}

function isAnalyticsExportResult(value: unknown): value is AnalyticsExportResult {
  return (
    value === "downloaded" || value === "too_many" || value === "inaccessible" || value === "failed"
  );
}

function isAnalyticsFeedbackType(value: unknown): value is AnalyticsFeedbackType {
  return value === "bug" || value === "feature" || value === "currency";
}

function isNonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function validatePropValue(event: AnalyticsEvent, key: string, value: unknown) {
  if (value === undefined) {
    return false;
  }
  switch (event) {
    case "circle_created":
      return key === "currency" && typeof value === "string" && isSupportedCurrency(value);
    case "transaction_added":
      if (key === "type") return isAnalyticsTransactionType(value);
      if (key === "paidBySelf") return typeof value === "boolean";
      if (key === "categoryCount") return isNonNegativeInteger(value);
      return false;
    case "category_created":
      if (key === "type") return isAnalyticsCategoryType(value);
      if (key === "source") return isAnalyticsCategorySource(value);
      return false;
    case "ledger_filter_applied":
    case "transaction_search_submitted":
      if (key === "type") return isAnalyticsTransactionType(value);
      if (key === "status") return isAnalyticsLifecycleStatus(value);
      if (key === "hasQuery" || key === "hasDateRange" || key === "hasAmountRange") {
        return typeof value === "boolean";
      }
      if (key === "categoryCount" || key === "recordedByCount" || key === "paidByCount") {
        return isNonNegativeInteger(value);
      }
      if (key === "monthOffset" && event === "ledger_filter_applied") {
        return typeof value === "number" && Number.isInteger(value);
      }
      return false;
    case "transaction_search_page_changed":
      return key === "page" && isPositiveInteger(value);
    case "export_performed":
      if (key === "status") return isAnalyticsLifecycleStatus(value);
      if (key === "result") return isAnalyticsExportResult(value);
      if (key === "hasQuery" || key === "hasDateRange" || key === "hasAmountRange") {
        return typeof value === "boolean";
      }
      return false;
    case "feedback_submitted":
      return key === "type" && isAnalyticsFeedbackType(value);
    default:
      return false;
  }
}

function isCircleCreatedPayload(
  value: Record<string, unknown>,
): value is AnalyticsEventMap["circle_created"] {
  return (
    typeof value.currency === "string" &&
    isSupportedCurrency(value.currency) &&
    Object.keys(value).length === 1
  );
}

function isTransactionAddedPayload(
  value: Record<string, unknown>,
): value is AnalyticsEventMap["transaction_added"] {
  return (
    isAnalyticsTransactionType(value.type) &&
    typeof value.paidBySelf === "boolean" &&
    isNonNegativeInteger(value.categoryCount) &&
    Object.keys(value).length === 3
  );
}

function isCategoryCreatedPayload(
  value: Record<string, unknown>,
): value is AnalyticsEventMap["category_created"] {
  return (
    isAnalyticsCategoryType(value.type) &&
    isAnalyticsCategorySource(value.source) &&
    Object.keys(value).length === 2
  );
}

function isLedgerFilterAppliedPayload(
  value: Record<string, unknown>,
): value is AnalyticsEventMap["ledger_filter_applied"] {
  return (
    isAnalyticsTransactionType(value.type) &&
    isAnalyticsLifecycleStatus(value.status) &&
    typeof value.hasQuery === "boolean" &&
    isNonNegativeInteger(value.categoryCount) &&
    isNonNegativeInteger(value.recordedByCount) &&
    isNonNegativeInteger(value.paidByCount) &&
    typeof value.monthOffset === "number" &&
    Number.isInteger(value.monthOffset) &&
    Object.keys(value).length === 7
  );
}

function isTransactionSearchSubmittedPayload(
  value: Record<string, unknown>,
): value is AnalyticsEventMap["transaction_search_submitted"] {
  return (
    isAnalyticsTransactionType(value.type) &&
    isAnalyticsLifecycleStatus(value.status) &&
    typeof value.hasQuery === "boolean" &&
    typeof value.hasDateRange === "boolean" &&
    typeof value.hasAmountRange === "boolean" &&
    isNonNegativeInteger(value.categoryCount) &&
    isNonNegativeInteger(value.recordedByCount) &&
    isNonNegativeInteger(value.paidByCount) &&
    Object.keys(value).length === 8
  );
}

function isTransactionSearchPageChangedPayload(
  value: Record<string, unknown>,
): value is AnalyticsEventMap["transaction_search_page_changed"] {
  return isPositiveInteger(value.page) && Object.keys(value).length === 1;
}

function isExportPerformedPayload(
  value: Record<string, unknown>,
): value is AnalyticsEventMap["export_performed"] {
  return (
    isAnalyticsLifecycleStatus(value.status) &&
    isAnalyticsExportResult(value.result) &&
    typeof value.hasQuery === "boolean" &&
    typeof value.hasDateRange === "boolean" &&
    typeof value.hasAmountRange === "boolean" &&
    Object.keys(value).length === 5
  );
}

function isFeedbackSubmittedPayload(
  value: Record<string, unknown>,
): value is AnalyticsEventMap["feedback_submitted"] {
  return isAnalyticsFeedbackType(value.type) && Object.keys(value).length === 1;
}

function toValidatedPayload(
  event: "circle_created",
  sanitized: Record<string, unknown>,
): AnalyticsEventMap["circle_created"] | null;
function toValidatedPayload(
  event: "transaction_added",
  sanitized: Record<string, unknown>,
): AnalyticsEventMap["transaction_added"] | null;
function toValidatedPayload(
  event: "category_created",
  sanitized: Record<string, unknown>,
): AnalyticsEventMap["category_created"] | null;
function toValidatedPayload(
  event: "ledger_filter_applied",
  sanitized: Record<string, unknown>,
): AnalyticsEventMap["ledger_filter_applied"] | null;
function toValidatedPayload(
  event: "transaction_search_submitted",
  sanitized: Record<string, unknown>,
): AnalyticsEventMap["transaction_search_submitted"] | null;
function toValidatedPayload(
  event: "transaction_search_page_changed",
  sanitized: Record<string, unknown>,
): AnalyticsEventMap["transaction_search_page_changed"] | null;
function toValidatedPayload(
  event: "export_performed",
  sanitized: Record<string, unknown>,
): AnalyticsEventMap["export_performed"] | null;
function toValidatedPayload(
  event: "feedback_submitted",
  sanitized: Record<string, unknown>,
): AnalyticsEventMap["feedback_submitted"] | null;
function toValidatedPayload(
  event: AnalyticsEvent,
  sanitized: Record<string, unknown>,
): AnalyticsEventMap[AnalyticsEvent] | null;
function toValidatedPayload(event: AnalyticsEvent, sanitized: Record<string, unknown>) {
  switch (event) {
    case "circle_created":
      return isCircleCreatedPayload(sanitized) ? sanitized : null;
    case "transaction_added":
      return isTransactionAddedPayload(sanitized) ? sanitized : null;
    case "category_created":
      return isCategoryCreatedPayload(sanitized) ? sanitized : null;
    case "ledger_filter_applied":
      return isLedgerFilterAppliedPayload(sanitized) ? sanitized : null;
    case "transaction_search_submitted":
      return isTransactionSearchSubmittedPayload(sanitized) ? sanitized : null;
    case "transaction_search_page_changed":
      return isTransactionSearchPageChangedPayload(sanitized) ? sanitized : null;
    case "export_performed":
      return isExportPerformedPayload(sanitized) ? sanitized : null;
    case "feedback_submitted":
      return isFeedbackSubmittedPayload(sanitized) ? sanitized : null;
    default:
      return null;
  }
}

export function sanitizeAnalyticsProps<E extends AnalyticsEvent>(
  event: E,
  props: AnalyticsEventMap[E] | undefined,
) {
  if (props === undefined) {
    return null;
  }
  if (!isRecord(props)) {
    return null;
  }

  const allowlist = EVENT_ALLOWLISTS[event];
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(props)) {
    if (hasForbiddenKey(key) || !allowlist.has(key)) {
      continue;
    }
    if (!validatePropValue(event, key, value)) {
      continue;
    }
    sanitized[key] = value;
  }

  for (const required of allowlist) {
    if (!(required in sanitized)) {
      return null;
    }
  }

  return toValidatedPayload(event, sanitized);
}

export function isAnalyticsEvent(event: string): event is AnalyticsEvent {
  return Object.hasOwn(EVENT_ALLOWLISTS, event);
}
