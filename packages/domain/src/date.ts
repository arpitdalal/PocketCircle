/**
 * Transaction Dates are plain calendar dates with no timezone conversion, so
 * search and monthly reports match the date the user entered (PRD stories 33).
 * Plain dates are "YYYY-MM-DD" strings; months are "YYYY-MM" strings. Operational
 * timestamps (audit/history) are handled separately as epoch millis.
 */
export type PlainDate = string; // "YYYY-MM-DD"
export type PlainMonth = string; // "YYYY-MM"

const PLAIN_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PLAIN_MONTH_RE = /^\d{4}-\d{2}$/;

export function isValidPlainDate(value: string | null | undefined): value is PlainDate {
  if (value == null || !PLAIN_DATE_RE.test(value)) {
    return false;
  }
  const [yearPart = "", monthPart = "", dayPart = ""] = value.split("-");
  const year = Number(yearPart);
  const month = Number(monthPart);
  const day = Number(dayPart);
  if (month < 1 || month > 12) {
    return false;
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth;
}

export function isValidPlainMonth(value: string | null | undefined): value is PlainMonth {
  if (value == null || !PLAIN_MONTH_RE.test(value)) {
    return false;
  }
  const month = Number(value.split("-")[1]);
  return month >= 1 && month <= 12;
}

/** Returns the "YYYY-MM" bucket a plain date belongs to. */
export function monthOf(date: PlainDate): PlainMonth {
  return date.slice(0, 7);
}

/** Today's plain date for a given timezone offset is intentionally not derived
 * here; callers pass a Date (usually `new Date()`) and we read its local parts. */
export function toPlainDate(date: Date): PlainDate {
  const year = date.getFullYear().toString().padStart(4, "0");
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function currentMonth(date: Date): PlainMonth {
  return toPlainDate(date).slice(0, 7);
}

/**
 * The date a new Transaction should default to while a given month is in view.
 * If `today` falls in the selected month, use today (the common case — recording
 * as you go); otherwise anchor to the first of the selected month so the create
 * lands inside the month the user is looking at, not silently in the current one.
 */
export function defaultDateInMonth(month: PlainMonth, today: Date): PlainDate {
  const todayDate = toPlainDate(today);
  return monthOf(todayDate) === month ? todayDate : `${month}-01`;
}

/**
 * The numeric parts of a "YYYY-MM" month: the year and the 1-based month. The ONE
 * sanctioned way to read a PlainMonth's numbers — `PlainMonth` is structurally a
 * string, so ad-hoc `split(...) as [number, number]` tuple casts would let a
 * malformed value fabricate `undefined as number`; here a missing part is an honest
 * `NaN`, which downstream Date construction and arithmetic surface as invalid
 * instead of silently mislabelling a month.
 */
export function plainMonthParts(month: PlainMonth): { year: number; month: number } {
  // A missing or empty part is NaN explicitly — `Number("")` would be 0, and a
  // fabricated year/month 0 can masquerade as real data where NaN cannot.
  const numberPart = (part: string | undefined) => (part ? Number(part) : Number.NaN);
  const [yearPart, monthPart] = month.split("-");
  return { year: numberPart(yearPart), month: numberPart(monthPart) };
}

/** Moves a "YYYY-MM" month by `delta` months (negative moves backward). */
export function addMonths(month: PlainMonth, delta: number): PlainMonth {
  const { year, month: monthIndex } = plainMonthParts(month);
  const zeroBased = year * 12 + (monthIndex - 1) + delta;
  const newYear = Math.floor(zeroBased / 12);
  const newMonth = (zeroBased % 12) + 1;
  return `${newYear.toString().padStart(4, "0")}-${newMonth.toString().padStart(2, "0")}`;
}

/**
 * The Comparison Range (CONTEXT glossary): the Dashboard's month-over-month window
 * is 1, 3, 6, or 12 months and defaults to six. One definition shared by the
 * backend (arg validation) and the UI (the range selector) so neither can offer or
 * accept a window the other doesn't understand.
 */
export const COMPARISON_RANGE_OPTIONS = [1, 3, 6, 12] as const;
export type ComparisonRangeMonths = (typeof COMPARISON_RANGE_OPTIONS)[number];
export const DEFAULT_COMPARISON_RANGE_MONTHS = 6 as const satisfies ComparisonRangeMonths;

/**
 * Home Summary range — reuses the same calendar-month window vocabulary as the
 * Dashboard Comparison Range (same [1, 3, 6, 12] set and `comparisonWindowMonths`
 * builder) with a distinct default of 1 month (GH-273). Keeps the two surfaces
 * decoupled so a future change to one default doesn't silently change the other.
 */
export const HOME_RANGE_OPTIONS = COMPARISON_RANGE_OPTIONS;
export type HomeRangeMonths = ComparisonRangeMonths;
export const DEFAULT_HOME_RANGE_MONTHS = 1 as const satisfies HomeRangeMonths;

export function isComparisonRangeMonths(value: number): value is ComparisonRangeMonths {
  return COMPARISON_RANGE_OPTIONS.some((option) => option === value);
}

export function isHomeRangeMonths(value: number): value is HomeRangeMonths {
  return isComparisonRangeMonths(value);
}

/**
 * The chronological window of `rangeMonths` months ENDING at `endMonth` (inclusive)
 * — the month buckets a Comparison Range covers. Built on `addMonths`/`monthRange`
 * so year-boundary spans are correct, and ascending so a series derived from it is
 * chronological by construction.
 */
export function comparisonWindowMonths(
  endMonth: PlainMonth,
  rangeMonths: ComparisonRangeMonths,
): PlainMonth[] {
  return monthRange(addMonths(endMonth, -(rangeMonths - 1)), endMonth);
}

/** Inclusive list of months between two months, ascending. */
export function monthRange(from: PlainMonth, to: PlainMonth): PlainMonth[] {
  const months: PlainMonth[] = [];
  let cursor = from;
  while (cursor <= to) {
    months.push(cursor);
    cursor = addMonths(cursor, 1);
  }
  return months;
}
