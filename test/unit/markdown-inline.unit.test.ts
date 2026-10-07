/**
 * Inline-markdown tokenizer contract (`@/lib/assistant/markdown-inline`).
 *
 * The chat renders replies with a typewriter reveal, so the tokenizer is what
 * decides which delimiters become real styling — and, just as important, which
 * ones stay visible text. The demo script exercises all three forms: the
 * `### **…**` heading and the `**نسبة الثقة:**` label (bold), the
 * `88% · ثقة مرتفعة` chip (code) and the species names
 * (*Botryosphaeriaceae*, *Fusarium*) added with the enriched diagnoses
 * (italic) — the last one used to print its asterisks on screen.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTokens } from "../../src/lib/assistant/markdown-inline";

const kinds = (raw: string) => parseTokens(raw).map((token) => token.kind);
const texts = (raw: string) => parseTokens(raw).map((token) => token.text);

test("bold, code and italic spans become tokens, delimiters stripped", () => {
  assert.deepEqual(parseTokens("**اسم المنتج:** أكسي كلورور النحاس 50%"), [
    { kind: "bold", text: "اسم المنتج:" },
    { kind: "plain", text: " أكسي كلورور النحاس 50%" },
  ]);
  assert.deepEqual(parseTokens("**نسبة الثقة:** `88% · ثقة مرتفعة`"), [
    { kind: "bold", text: "نسبة الثقة:" },
    { kind: "plain", text: " " },
    { kind: "code", text: "88% · ثقة مرتفعة" },
  ]);
  // The enriched-diagnosis case: species names in *single asterisks*.
  assert.deepEqual(parseTokens("(غالباً من عائلة *Botryosphaeriaceae* أو *Fusarium*)"), [
    { kind: "plain", text: "(غالباً من عائلة " },
    { kind: "italic", text: "Botryosphaeriaceae" },
    { kind: "plain", text: " أو " },
    { kind: "italic", text: "Fusarium" },
    { kind: "plain", text: ")" },
  ]);
});

test("`**bold**` is never mistaken for two italics", () => {
  assert.deepEqual(kinds("**مانكوزيب 80%** و **تيفانات الميثيل 70%**"), [
    "bold",
    "plain",
    "bold",
  ]);
  // A bold span keeps its inner punctuation and Latin words intact.
  assert.deepEqual(parseTokens("**تيفانات الميثيل 70%** (Thiophanate-Methyl)"), [
    { kind: "bold", text: "تيفانات الميثيل 70%" },
    { kind: "plain", text: " (Thiophanate-Methyl)" },
  ]);
});

test("a lone or unfinished delimiter stays plain text (no stray asterisks mid-animation)", () => {
  assert.deepEqual(parseTokens("pH 6.0 *"), [{ kind: "plain", text: "pH 6.0 *" }]);
  assert.deepEqual(parseTokens("2 * 3 = 6"), [{ kind: "plain", text: "2 * 3 = 6" }]);
  assert.deepEqual(parseTokens("**غير مكتمل"), [{ kind: "plain", text: "**غير مكتمل" }]);
  assert.deepEqual(parseTokens("`88%"), [{ kind: "plain", text: "`88%" }]);
});

test("the plain text of a tokenized line concatenates back to the source", () => {
  const line =
    "• **اسم المنتج العلاجي:** مبيد فطر وعائي مركّب: **مانكوزيب 80%** (Mancozeb) مع `150 غرام` من *Thiophanate-Methyl*.";
  assert.equal(texts(line).join(""), line.replace(/\*\*|`|\*/g, ""));
  assert.deepEqual(kinds(line), ["plain", "bold", "plain", "bold", "plain", "code", "plain", "italic", "plain"]);
});

test("the digits-and-percent chip keeps its LTR content untouched", () => {
  assert.deepEqual(parseTokens("`85% · ثقة مرتفعة`"), [
    { kind: "code", text: "85% · ثقة مرتفعة" },
  ]);
});
