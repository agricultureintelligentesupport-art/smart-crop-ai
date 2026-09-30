/**
 * One number/date formatter for the whole draw → confirm → analyze flow.
 *
 * Presentation only: the values themselves are produced by `lib/` and arrive
 * untouched. Latin digits in both languages (an Algerian farmer reads `2.35 ha`,
 * not `٢٫٣٥`), the locale decides the decimal separator, and a missing value
 * always prints the same em dash so no screen invents its own placeholder.
 */

import type { Lang } from "@/lib/wilayas";

/** Missing measurement — identical everywhere, never a zero. */
export const NO_VALUE = "—";

/** Latin digits, tabulated, one locale per language. */
export function formatNumber(
  lang: Lang,
  value: number | null | undefined,
  decimals = 0,
  unit = "",
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NO_VALUE;
  const text = new Intl.NumberFormat(lang === "ar" ? "ar-DZ-u-nu-latn" : "fr-FR", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
  return unit ? `${text} ${unit}` : text;
}

/** Short day, e.g. «12 سبتمبر 2026» / «12 sept. 2026 ». */
export function formatDate(lang: Lang, iso: string | null | undefined): string {
  if (!iso) return NO_VALUE;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(lang === "ar" ? "ar-DZ" : "fr-FR", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

/** WGS84 degrees, always LTR inside an RTL sentence. */
export function formatDegrees(value: number, decimals = 6): string {
  return `${value.toFixed(decimals)}°`;
}
