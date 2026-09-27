/**
 * Unit tests for the orchestrator's inter-stage contract:
 * `src/lib/assistant/analysis.ts`.
 *
 * The rules under test are the ones the pipeline depends on most:
 *   • the MobileNetV2 fallback output is mapped into the EXACT schema Gemini
 *     produces, so the text stage is source-agnostic;
 *   • ONLY a malformed / incomplete Gemini payload is a failure — a low or
 *     out-of-range `confidence` is data, never a routing signal;
 *   • the analysis projects cleanly onto the diagnosis card the UI renders.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ANALYSIS_RESPONSE_SCHEMA,
  AnalysisParseError,
  analysisToDiagnosis,
  classificationToAnalysis,
  emptyAnalysis,
  parseAnalysisJson,
} from "../../src/lib/assistant/analysis";
import { diseaseFamilyForArabic } from "../../src/lib/assistant/plantvillage";

const VALID = {
  plant_type: "الطماطم",
  disease_detected: true,
  disease_name: "اللفحة المتأخرة",
  confidence: 0.82,
  affected_parts: ["الأوراق السفلية"],
  severity: "medium",
  symptoms_observed: ["بقع بنية داكنة"],
  notes: "ملاحظة",
};

/* ------------------------------------------------------------------ */
/*  parseAnalysisJson — the three Step 1 failure modes                  */
/* ------------------------------------------------------------------ */

test("parseAnalysisJson accepts a complete AnalysisData object verbatim", () => {
  const data = parseAnalysisJson(JSON.stringify(VALID));
  assert.deepEqual(data, VALID);
});

test("parseAnalysisJson tolerates a ```json code fence around the object", () => {
  const data = parseAnalysisJson("```json\n" + JSON.stringify(VALID) + "\n```");
  assert.deepEqual(data, VALID);
});

/** Every one of these must throw — they are exactly the Step 1 failures. */
for (const [name, payload] of [
  ["an empty response", ""],
  ["free text", "الورقة مصابة باللفحة المتأخرة."],
  ["truncated JSON", '{"plant_type":"الطماطم","disease_det'],
  ["a JSON array", '[{"plant_type":"الطماطم"}]'],
  ["a JSON string", '"not an object"'],
  ["a JSON number", "42"],
  ["an empty object", "{}"],
] as const) {
  test(`parseAnalysisJson rejects ${name}`, () => {
    assert.throws(() => parseAnalysisJson(payload), AnalysisParseError);
  });
}

test("parseAnalysisJson names the missing fields so the failure is diagnosable", () => {
  assert.throws(
    () => parseAnalysisJson(JSON.stringify({ plant_type: "الطماطم", confidence: 0.9 })),
    /missing required field\(s\): disease_detected, disease_name/,
  );
});

test("parseAnalysisJson rejects a field present but explicitly undefined", () => {
  const raw = JSON.stringify({ ...VALID, severity: undefined });
  assert.throws(() => parseAnalysisJson(raw), /missing required field\(s\): severity/);
});

/* ------------------------------------------------------------------ */
/*  confidence is DATA, never a routing signal                          */
/* ------------------------------------------------------------------ */

test("a very low confidence parses fine — it is never a failure", () => {
  const data = parseAnalysisJson(JSON.stringify({ ...VALID, confidence: 0.01 }));
  assert.equal(data.confidence, 0.01);
  assert.equal(data.disease_detected, true);
});

test("an out-of-range confidence is clamped into [0, 1], not rejected", () => {
  assert.equal(parseAnalysisJson(JSON.stringify({ ...VALID, confidence: 1.4 })).confidence, 1);
  assert.equal(parseAnalysisJson(JSON.stringify({ ...VALID, confidence: -3 })).confidence, 0);
});

test("a stringified confidence is coerced rather than rejected", () => {
  assert.equal(parseAnalysisJson(JSON.stringify({ ...VALID, confidence: "0.66" })).confidence, 0.66);
});

/* ------------------------------------------------------------------ */
/*  normalisation of the other fields                                   */
/* ------------------------------------------------------------------ */

test("empty strings and the 'none' sentinel normalise to null", () => {
  const data = parseAnalysisJson(
    JSON.stringify({
      ...VALID,
      plant_type: "   ",
      severity: "none",
    }),
  );
  assert.equal(data.plant_type, null);
  assert.equal(data.severity, null);
});

test("a non-array list field is coerced into a string array", () => {
  const data = parseAnalysisJson(
    JSON.stringify({ ...VALID, symptoms_observed: "بقع بنية", affected_parts: [] }),
  );
  assert.deepEqual(data.symptoms_observed, ["بقع بنية"]);
  assert.deepEqual(data.affected_parts, []);
});

test("a 'no disease' verdict can never smuggle a disease name through", () => {
  const data = parseAnalysisJson(
    JSON.stringify({ ...VALID, disease_detected: false, severity: "none" }),
  );
  assert.equal(data.disease_detected, false);
  assert.equal(data.disease_name, null);
  assert.equal(data.severity, null);
});

test("a stringified boolean is coerced for disease_detected", () => {
  assert.equal(
    parseAnalysisJson(JSON.stringify({ ...VALID, disease_detected: "true" })).disease_detected,
    true,
  );
  assert.equal(
    parseAnalysisJson(JSON.stringify({ ...VALID, disease_detected: "false" })).disease_detected,
    false,
  );
});

test("the severity enum is constrained to low | medium | high", () => {
  for (const [input, expected] of [
    ["low", "low"],
    ["HIGH", "high"],
    ["Medium", "medium"],
    ["catastrophic", null],
  ] as const) {
    assert.equal(parseAnalysisJson(JSON.stringify({ ...VALID, severity: input })).severity, expected);
  }
});

/* ------------------------------------------------------------------ */
/*  the MobileNetV2 fallback mapping                                   */
/* ------------------------------------------------------------------ */

test("classificationToAnalysis maps label + score into the Gemini schema", () => {
  const data = classificationToAnalysis("Tomato___Late_blight", 0.93);
  assert.deepEqual(Object.keys(data).sort(), Object.keys(VALID).sort());
  assert.equal(data.plant_type, "الطماطم");
  assert.equal(data.disease_detected, true);
  assert.equal(data.disease_name, "الطماطم — اللفحة المتأخرة");
  assert.equal(data.confidence, 0.93);
  // MobileNetV2 genuinely cannot express these, so they stay empty rather
  // than being invented.
  assert.deepEqual(data.affected_parts, []);
  assert.deepEqual(data.symptoms_observed, []);
  assert.equal(data.severity, null);
  assert.equal(data.notes, "");
});

test("a healthy PlantVillage label yields a no-disease analysis", () => {
  const data = classificationToAnalysis("Tomato___healthy", 0.97);
  assert.equal(data.disease_detected, false);
  assert.equal(data.disease_name, null);
  assert.equal(data.plant_type, "الطماطم");
  assert.equal(data.confidence, 0.97);
});

/* ------------------------------------------------------------------ */
/*  projection onto the diagnosis card                                 */
/* ------------------------------------------------------------------ */

test("analysisToDiagnosis renders a Gemini disease verdict for the card", () => {
  const data = parseAnalysisJson(JSON.stringify(VALID));
  const diagnosis = analysisToDiagnosis(data, "gemini", { model: "gemini-3.6" });
  assert.equal(diagnosis.labelAr, "اللفحة المتأخرة");
  assert.equal(diagnosis.cropAr, "الطماطم");
  assert.equal(diagnosis.healthy, false);
  assert.equal(diagnosis.confidence, 0.82);
  assert.equal(diagnosis.model, "gemini-3.6");
  assert.equal(diagnosis.engine, "gemini-vision");
  assert.equal(diagnosis.severity, "متوسطة");
  assert.deepEqual(diagnosis.symptoms, ["بقع بنية داكنة"]);
  assert.deepEqual(diagnosis.candidates, []);
});

test("analysisToDiagnosis localises severity into the reply language", () => {
  const data = parseAnalysisJson(JSON.stringify({ ...VALID, severity: "high" }));
  assert.equal(
    analysisToDiagnosis(data, "gemini", { model: "gemini-3.6", lang: "fr" }).severity,
    "élevée",
  );
  assert.equal(
    analysisToDiagnosis(data, "gemini", { model: "gemini-3.6", lang: "ar" }).severity,
    "عالية",
  );
});

test("analysisToDiagnosis renders a healthy Gemini verdict as reassuring", () => {
  const data = parseAnalysisJson(
    JSON.stringify({ ...VALID, disease_detected: false, disease_name: "", severity: "none" }),
  );
  const diagnosis = analysisToDiagnosis(data, "gemini", { model: "gemini-3.6" });
  assert.equal(diagnosis.healthy, true);
  assert.match(diagnosis.labelAr, /سليمة/);
  assert.equal(diagnosis.severity, null);
});

test("analysisToDiagnosis keeps the raw label + candidates for MobileNetV2", () => {
  const candidates = [
    { label: "Tomato___Late_blight", score: 0.93 },
    { label: "Tomato___Early_blight", score: 0.05 },
  ];
  const data = classificationToAnalysis(candidates[0].label, candidates[0].score);
  const diagnosis = analysisToDiagnosis(data, "mobilenet", {
    model: "linkanjarad/mobilenet_v2_1.0_224",
    rawLabel: candidates[0].label,
    candidates,
  });
  // The raw label is preserved for the disease-family advice matcher…
  assert.equal(diagnosis.label, "Tomato___Late_blight");
  assert.equal(diagnosis.labelAr, "الطماطم — اللفحة المتأخرة");
  assert.equal(diagnosis.engine, "plantvillage-hf");
  // …and the runner-up classes stay available to the card.
  assert.deepEqual(diagnosis.candidates, candidates);
});

test("emptyAnalysis is fully populated, not partially undefined", () => {
  const empty = emptyAnalysis();
  assert.deepEqual(Object.keys(empty).sort(), Object.keys(VALID).sort());
  assert.equal(empty.disease_detected, false);
  assert.equal(empty.disease_name, null);
  assert.equal(empty.plant_type, null);
  assert.equal(empty.confidence, 0);
  assert.deepEqual(empty.affected_parts, []);
  assert.deepEqual(empty.symptoms_observed, []);
  assert.equal(empty.severity, null);
  assert.equal(empty.notes, "");
});

/* ------------------------------------------------------------------ */
/*  the Gemini response schema                                          */
/* ------------------------------------------------------------------ */

test("the response schema requires exactly the eight AnalysisData fields", () => {
  assert.deepEqual([...ANALYSIS_RESPONSE_SCHEMA.required].sort(), Object.keys(VALID).sort());
  assert.equal(ANALYSIS_RESPONSE_SCHEMA.type, "OBJECT");
  assert.equal(ANALYSIS_RESPONSE_SCHEMA.properties.severity.type, "STRING");
});

/* ------------------------------------------------------------------ */
/*  Arabic → English family reverse lookup                              */
/* ------------------------------------------------------------------ */

test("diseaseFamilyForArabic maps a localised Gemini name back to its family", () => {
  assert.equal(diseaseFamilyForArabic("اللفحة المتأخرة"), "late blight");
  assert.equal(diseaseFamilyForArabic("البياض الدقيقي"), "powdery mildew");
  assert.equal(diseaseFamilyForArabic("التبقع البكتيري"), "bacterial spot");
  // A name with extra context still matches.
  assert.equal(diseaseFamilyForArabic("اللفحة المتأخرة على الطماطم"), "late blight");
  assert.equal(diseaseFamilyForArabic("نبتة سليمة"), null);
  assert.equal(diseaseFamilyForArabic(""), null);
});
