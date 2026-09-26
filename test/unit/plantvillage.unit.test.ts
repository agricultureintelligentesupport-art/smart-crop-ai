import assert from "node:assert/strict";
import test from "node:test";
import { confidenceBucket, parsePlantLabel } from "../../src/lib/assistant/plantvillage";
import { ASSISTANT } from "../../src/lib/assistant/copy";

test("diagnosis display strips crops from natural and PlantVillage labels", () => {
  for (const raw of ["Potato with Late Blight", "Potato___Late_blight", "Tomato___Late_blight", "Late Blight", " potato WITH late blight "]) {
    const parsed = parsePlantLabel(raw);
    assert.equal(parsed.diseaseName, "اللفحة المتأخرة");
    assert.equal(parsed.diseaseType, "fungal");
  }
});

test("untranslated diseases retain readable disease-only fallback names", () => {
  for (const raw of ["Potato___Novel_condition", "Potato with Novel condition", "Potato Novel condition"]) {
    assert.equal(parsePlantLabel(raw).diseaseName, "Novel condition");
    assert.equal(parsePlantLabel(raw).diseaseType, "unknown");
  }
  assert.equal(parsePlantLabel("Unrecognised label").diseaseName, "Unrecognised label");
});

test("badge distinguishes non-fungal classifications and healthy plants", () => {
  for (const [label, type] of [
    ["Tomato___Bacterial_spot", "bacterial"],
    ["Tomato___Tomato_mosaic_virus", "viral"],
    ["Tomato___Spider_mites Two-spotted_spider_mite", "pest"],
    ["Apple___healthy", "unknown"],
  ]) assert.equal(parsePlantLabel(label).diseaseType, type);
  assert.equal(parsePlantLabel("Apple___healthy").healthy, true);
  assert.equal(parsePlantLabel("Apple___healthy").diseaseName, "نبتة سليمة ✅");
});

test("crop-qualified labels used by prompts and fallback replies are unchanged", () => {
  const parsed = parsePlantLabel("Potato___Late_blight");
  assert.equal(parsed.labelAr, "البطاطا — اللفحة المتأخرة");
  assert.equal(parsed.cropAr, "البطاطا");
  assert.equal(parsed.diseaseAr, "اللفحة المتأخرة");
  assert.equal(parsePlantLabel("Apple___healthy").labelAr, "التفاح — نبتة سليمة ✅");
  assert.equal(parsePlantLabel("Potato___Novel_condition").labelAr, "Potato — Novel condition");
  assert.equal(confidenceBucket(0.96), "high");
  assert.equal(confidenceBucket(0.75), "high");
  assert.equal(confidenceBucket(0.45), "medium");
  assert.equal(confidenceBucket(0.44), "low");
});

test("diagnosis copy includes the requested note and localized type badges", () => {
  assert.equal(ASSISTANT.ar.diagnosis.affectedCrops, "مرض يصيب عدة محاصيل تشترك في نفس الأعراض (مثل: البطاطس، الطماطم، الفول، والباذنجان).");
  assert.equal(ASSISTANT.ar.diagnosis.diseaseTypes.fungal, "مرض فطري");
  assert.equal(ASSISTANT.fr.diagnosis.diseaseTypes.fungal, "Maladie fongique");
});
