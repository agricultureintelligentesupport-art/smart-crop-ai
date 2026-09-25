/**
 * Number and template formatting shared by every dashboard surface.
 *
 * Values on this dashboard are Latin/numeric, so they are always formatted with
 * `en-US` (thousands separators, dot decimal) and pinned LTR where they are
 * rendered — never localised into Arabic-Indic digits, which would break the
 * formula chains the cards print.
 *
 * `WeatherCard.tsx` re-exports `fmt` for the components that have imported it
 * from there since the first dashboard, so the one formatter has a single home.
 */

/** Latin/numeric display formatting (`digits` fixed decimals). */
export const fmt = (value: number, digits = 0) =>
  new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);

/**
 * Fills `{token}` placeholders in a copy template. Unknown tokens are left
 * untouched (same contract as the sheets' own lines, so a missing value shows
 * up as `{token}` instead of silently printing "undefined").
 */
export const fillTemplate = (template: string, values: Record<string, string | number>): string =>
  template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
