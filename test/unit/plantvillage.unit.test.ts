/**
 * Disease-only display names: crop prefixes and suffixes are stripped from
 * every diagnosis string the card, the fallback card and the LLM prompt show.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { diseaseOnlyName, parsePlantLabel } from "../../src/lib/assistant/plantvillage";

test("diseaseOnlyName strips an Arabic crop prefix and keeps a custom spelling", () => {
  assert.equal(diseaseOnlyName("الذرة — التبقّع الرمادي للأوراق"), "التبقّع الرمادي للأوراق");
  assert.equal(diseaseOnlyName("الذرة — الصدأ الشائع"), "الصدأ الشائع");
});

test("diseaseOnlyName strips crop suffixes, parenthetical hosts and English 'of crop'", () => {
  assert.equal(diseaseOnlyName("الصدأ الشائع — الذرة"), "الصدأ الشائع");
  assert.equal(diseaseOnlyName("التبقّع الرمادي للأوراق (الذرة)"), "التبقّع الرمادي للأوراق");
  assert.equal(diseaseOnlyName("Gray leaf spot of corn"), "التبقع الرمادي للأوراق");
  assert.equal(diseaseOnlyName("Common rust — Maize"), "الصدأ الشائع");
});

test("diseaseOnlyName translates prose English candidates and drops the crop", () => {
  assert.equal(diseaseOnlyName("Corn (Maize) with Common Rust"), "الصدأ الشائع");
  assert.equal(diseaseOnlyName("Healthy Corn (Maize) Plant"), "نبتة سليمة");
  assert.equal(diseaseOnlyName("Corn (Maize) with Northern Leaf Blight"), "اللفحة الشمالية للأوراق");
  assert.equal(diseaseOnlyName("Tomato with Early Blight"), "اللفحة المبكرة");
  assert.doesNotMatch(diseaseOnlyName("Corn (Maize) with Common Rust"), /corn|maize|ذرة/i);
});

test("diseaseOnlyName keeps official disease names that merely mention a host", () => {
  assert.equal(diseaseOnlyName("جرب التفاح"), "جرب التفاح");
  assert.equal(diseaseOnlyName("صدأ التفاح والعرعر"), "صدأ التفاح والعرعر");
  assert.equal(diseaseOnlyName("التفاح — جرب التفاح"), "جرب التفاح");
});

test("diseaseOnlyName localises raw PlantVillage labels to the disease only", () => {
  assert.equal(diseaseOnlyName("Corn_(maize)___Common_rust_"), "الصدأ الشائع");
  assert.equal(diseaseOnlyName("Corn_(maize)___Northern_Leaf_Blight"), "اللفحة الشمالية للأوراق");
  assert.equal(diseaseOnlyName("Tomato___Early_blight"), "اللفحة المبكرة");
  assert.equal(diseaseOnlyName("Tomato___Late_blight"), "اللفحة المتأخرة");
  assert.equal(diseaseOnlyName("Tomato___Leaf_Mold"), "عفن الأوراق");
  assert.equal(diseaseOnlyName("Potato___Late_blight"), "اللفحة المتأخرة");
  assert.equal(
    diseaseOnlyName("Corn_(maize)___Cercospora_leaf_spot Gray_leaf_spot"),
    "التبقع الرمادي للأوراق (سركوسبورا)",
  );
});

test("diseaseOnlyName drops the crop from healthy labels and unknown disease sides", () => {
  assert.equal(diseaseOnlyName("Tomato___healthy"), "نبتة سليمة");
  assert.equal(diseaseOnlyName("الطماطم — نبتة سليمة ✅"), "نبتة سليمة");
  assert.equal(diseaseOnlyName("Foo___Mystery_syndrome"), "Mystery syndrome");
});

test("parsePlantLabel still keeps crop and disease for classification data", () => {
  const parsed = parsePlantLabel("Corn_(maize)___Common_rust_");
  assert.equal(parsed.cropAr, "الذرة");
  assert.equal(parsed.diseaseAr, "الصدأ الشائع");
  assert.equal(parsed.labelAr, "الذرة — الصدأ الشائع");
  assert.equal(parsed.healthy, false);
});
