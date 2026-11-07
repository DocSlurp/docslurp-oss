import type { TableCellValueType } from "@docslurp/shared";

/**
 * Types the cells of one table column.
 *
 * Numbers and dates are read per column, not per cell, because the same text
 * means different things in different locales: `1,234` is 1234 in a US column
 * and 1.234 in a German one, `04/05/2026` is 5 April or 4 May. A column's
 * locale is whatever its unambiguous cells allow; a cell that is still
 * ambiguous after that stays a string rather than becoming a wrong number or
 * date. Nothing here calls `new Date(string)` (a guessing parser: "Item 5"
 * became 2001-05-01) or reads the process time zone: dates are calendar
 * arithmetic and are written as `YYYY-MM-DD`.
 */

export interface TypedCell {
  valueType: TableCellValueType;
  typedValue: string | number | boolean | null;
}

type NumberLocale = "us" | "eu";

const US_NUMBER = /^(?:\d{1,3}(?:[,']\d{3})+|\d{1,2}(?:,\d{2})+,\d{3}|\d+)(?:\.\d+)?$/;
const EU_NUMBER = /^(?:\d{1,3}(?:[.   ]\d{3})+|\d+)(?:,\d+)?$/;
const CURRENCY_CODE = "(?:USD|EUR|GBP|JPY|CNY|RMB|CHF|CAD|AUD|NZD|SEK|NOK|DKK|PLN|CZK|HUF|RON|BGN|RUB|UAH|TRY|INR|KRW|BRL|MXN|ZAR|SGD|HKD|THB|IDR|MYR|PHP|VND|ILS|AED|SAR|EGP|NGN|KES|ARS|CLP|COP|PEN|TWD)";
const CURRENCY_SYMBOL = "\\p{Sc}";

/** Numeric readings of a digit string, one per locale whose separator grammar it satisfies. */
function readNumber(body: string): Partial<Record<NumberLocale, number>> {
  const readings: Partial<Record<NumberLocale, number>> = {};
  if (US_NUMBER.test(body)) readings.us = Number(body.replace(/[,']/g, ""));
  if (EU_NUMBER.test(body)) readings.eu = Number(body.replace(/[.   ]/g, "").replace(",", "."));
  return readings;
}

interface NumericShape {
  kind: "number" | "currency" | "percentage";
  negative: boolean;
  body: string;
  /** Currencies without minor units: a separator before three digits is always a thousands separator. */
  wholeUnits?: boolean;
}

const WHOLE_UNIT_CURRENCIES = /^(?:[¥￥₩₫]|JPY|KRW|VND|CLP|RMB)$/;

/** A shape's numeric readings; whole-unit currencies read their separators as thousands in every locale. */
function readShape(shape: NumericShape): Partial<Record<NumberLocale, number>> {
  if (shape.wholeUnits && /^(?:\d{1,3}(?:[,.'\u00a0\u202f ]\d{3})+|\d+)$/.test(shape.body)) {
    const whole = Number(shape.body.replace(/\D/g, ""));
    return { us: whole, eu: whole };
  }
  return readNumber(shape.body);
}

/** Longest cell read as a number, percentage, currency or date; longer cells are text and reach no regex (council K #3 audit). */
const TYPED_CELL_MAX_CHARS = 64;

function numericShape(value: string): NumericShape | null {
  if (value.length > TYPED_CELL_MAX_CHARS * 4) return null;
  let text = value.trim();
  if (text.length > TYPED_CELL_MAX_CHARS) return null;
  let negative = false;
  const parenthesized = text.match(/^\((.*)\)$/s);
  if (parenthesized) { negative = true; text = parenthesized[1]!.trim(); }
  const sign = text.match(/^([+\-−])\s*(.*)$/s);
  if (sign) { negative = negative || sign[1] !== "+"; text = sign[2]!; }

  // A percentage is short; the lazy body and \s* overlap, so longer cells never reach the regex (council K #3 audit).
  const percent = text.length <= TYPED_CELL_MAX_CHARS ? text.match(/^(\d[\d.,'   ]*?)\s*%$/) : null;
  if (percent) return { kind: "percentage", negative, body: percent[1]! };

  const currency =
    text.match(new RegExp(`^(?:${CURRENCY_SYMBOL}|${CURRENCY_CODE})\\s*([+\\-\\u2212]?)\\s*(\\d[\\d.,'\\u00a0\\u202f ]*)$`, "u")) ??
    text.match(new RegExp(`^(\\d[\\d.,'\\u00a0\\u202f ]*?)()\\s*(?:${CURRENCY_SYMBOL}|${CURRENCY_CODE})$`, "u"));
  if (currency) {
    const body = currency[2] || currency[1]!;
    const innerSign = currency[2] ? currency[1] : "";
    const symbol = (text.match(new RegExp(`${CURRENCY_SYMBOL}|${CURRENCY_CODE}`, "u")) ?? [""])[0];
    return { kind: "currency", negative: negative || (innerSign !== "" && innerSign !== "+"), body: body.trim(), wholeUnits: WHOLE_UNIT_CURRENCIES.test(symbol) };
  }
  if (/^\d[\d.,'   ]*$/.test(text)) return { kind: "number", negative, body: text.trim() };
  return null;
}

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6,
  july: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9, october: 10, oct: 10,
  november: 11, nov: 11, december: 12, dec: 12,
};

function calendarDate(year: number, month: number, day: number): string | null {
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  // UTC calendar arithmetic only: no parsing of text, no dependence on the process time zone.
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

type DateOrder = "dmy" | "mdy";
type DateReading = { fixed: string } | { numeric: [number, number, number]; orders: DateOrder[] };

/** A date's readings: fixed when its text is unambiguous, else one reading per day/month order it fits. */
function readDate(value: string): DateReading | null {
  if (value.length > TYPED_CELL_MAX_CHARS * 4) return null;
  const text = value.trim();
  if (text.length > TYPED_CELL_MAX_CHARS) return null;
  let m = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/);
  if (!m) m = text.match(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/);
  if (m) {
    const iso = calendarDate(Number(m[1]), Number(m[2]), Number(m[3]));
    return iso ? { fixed: iso } : null;
  }
  m = text.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日$/);
  if (m) {
    const iso = calendarDate(Number(m[1]), Number(m[2]), Number(m[3]));
    return iso ? { fixed: iso } : null;
  }
  // Dots between day, month and year are the day-first convention.
  m = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) {
    const iso = calendarDate(Number(m[3]), Number(m[2]), Number(m[1]));
    return iso ? { fixed: iso } : null;
  }
  m = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) {
    const [a, b, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const orders: DateOrder[] = [];
    if (calendarDate(year, b, a)) orders.push("dmy");
    if (calendarDate(year, a, b)) orders.push("mdy");
    return orders.length ? { numeric: [a, b, year], orders } : null;
  }
  m = text.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/);
  if (m) {
    const month = MONTHS[m[2]!.toLowerCase()];
    const iso = month ? calendarDate(Number(m[3]), month, Number(m[1])) : null;
    return iso ? { fixed: iso } : null;
  }
  m = text.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/);
  if (m) {
    const month = MONTHS[m[1]!.toLowerCase()];
    const iso = month ? calendarDate(Number(m[3]), month, Number(m[2])) : null;
    return iso ? { fixed: iso } : null;
  }
  return null;
}

const BOOLEAN = /^(true|false|yes|no)$/i;

/** Types every cell of a column together; `values` are the raw cell strings, in row order. */
export function typeColumn(values: string[]): { columnType: TableCellValueType; cells: TypedCell[] } {
  const trimmed = values.map((value) => value.trim());
  // A digit string is a number only when its separators fit a locale's grammar ("13.04.2026" is a date, "1.2.3" text),
  // and not when it is an identifier: leading zeros ("00123") or more digits than a double holds.
  const shapes = trimmed.map((value) => {
    const shape = value && !BOOLEAN.test(value) ? numericShape(value) : null;
    if (!shape) return null;
    const digits = shape.body.replace(/\D/g, "");
    if (digits.length > 15 || /^0\d/.test(shape.body)) return null;
    const readings = readShape(shape);
    return readings.us === undefined && readings.eu === undefined ? null : shape;
  });
  const dates = trimmed.map((value, index) => (value && !shapes[index] && !BOOLEAN.test(value) ? readDate(value) : null));

  // Locales every numeric cell of the column can be read in.
  let locales: NumberLocale[] = ["us", "eu"];
  for (const shape of shapes) {
    if (!shape) continue;
    const readings = readShape(shape);
    locales = locales.filter((locale) => readings[locale] !== undefined);
  }
  // Day/month orders every slash-or-dash date of the column can be read in.
  let orders: DateOrder[] = ["dmy", "mdy"];
  for (const date of dates) {
    if (date && "numeric" in date) orders = orders.filter((order) => date.orders.includes(order));
  }

  const cells = trimmed.map((value, index): TypedCell => {
    if (!value) return { valueType: "empty", typedValue: null };
    if (BOOLEAN.test(value)) return { valueType: "boolean", typedValue: /^(true|yes)$/i.test(value) };
    const shape = shapes[index];
    if (shape) {
      const readings = readShape(shape);
      const numbers = [...new Set(locales.map((locale) => readings[locale]).filter((n): n is number => n !== undefined))];
      // An empty locale set is a column that mixes conventions; several numbers is a cell the column cannot settle.
      if (numbers.length !== 1) return { valueType: "string", typedValue: value };
      return { valueType: shape.kind, typedValue: shape.negative ? -numbers[0]! : numbers[0]! };
    }
    const date = dates[index];
    if (date) {
      if ("fixed" in date) return { valueType: "date", typedValue: date.fixed };
      const results = new Set(orders.map((order) => {
        const [a, b, year] = date.numeric;
        return order === "dmy" ? calendarDate(year, b, a) : calendarDate(year, a, b);
      }));
      results.delete(null);
      if (results.size === 1) return { valueType: "date", typedValue: [...results][0]! };
    }
    return { valueType: "string", typedValue: value };
  });

  const types = new Set(cells.map((cell) => cell.valueType).filter((type) => type !== "empty"));
  const columnType: TableCellValueType = types.size === 0 ? "empty" : types.size === 1 ? [...types][0]! : "string";
  return { columnType, cells };
}
