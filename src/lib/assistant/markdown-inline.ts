/**
 * Inline-markdown tokenizer shared by the chat renderer
 * (`@/components/assistant/Markdown`) and its unit tests.
 *
 * The renderer reveals assistant replies with a progressive typewriter
 * animation, so inline syntax must be split into typed tokens BEFORE any
 * character reaches the screen — otherwise a half-typed `**` glitches as
 * literal asterisks mid-animation.
 *
 * Supported inline syntax (the subset the demo script and the model replies
 * actually use):
 *   **bold**  → <strong>   e.g. `**نسبة الثقة:**`, `**مانكوزيب 80%**`
 *   `code`    → <code>     e.g. the `88% · ثقة مرتفعة` confidence chip
 *   *italic*  → <em>       e.g. the species names *Botryosphaeriaceae*, *Fusarium*
 *   plain     → <span>
 *
 * Only COMPLETE delimiter pairs become tokens: a lone `*` (or an unfinished
 * `**`) stays plain text, so partial input never renders a stray delimiter.
 */

export type InlineTokenKind = "bold" | "code" | "italic" | "plain";

export interface InlineToken {
  kind: InlineTokenKind;
  text: string;
}

/**
 * One complete delimiter-wrapped span, or the plain run between two of them.
 * Bold is listed first so `**x**` is never mistaken for two italics.
 */
const INLINE_PATTERN = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;

export function parseTokens(raw: string): InlineToken[] {
  const parts = raw.split(INLINE_PATTERN).filter(Boolean);
  return parts.map((part) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return { kind: "bold", text: part.slice(2, -2) };
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return { kind: "code", text: part.slice(1, -1) };
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return { kind: "italic", text: part.slice(1, -1) };
    }
    return { kind: "plain", text: part };
  });
}
