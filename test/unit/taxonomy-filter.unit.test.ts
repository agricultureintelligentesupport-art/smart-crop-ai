import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyTaxonomyFilter,
  buildClarificationQuestions,
  buildFilterReport,
  CLARIFICATION_CROP_OPTIONS,
  cropKeyForLabel,
  DISEASE_TAXONOMY,
  resolveCropKey,
  taxonomyForLabel,
  type RawPrediction,
} from "../../src/lib/vision/taxonomyFilter";

/* ------------------------------------------------------------------ */
/*  Taxonomy integrity                                                 */
/* ------------------------------------------------------------------ */

/** The 38 PlantVillage classes MobileNetV2 was trained on. */
const PLANTVILLAGE_CLASSES = [
  "Apple___Apple_scab",
  "Apple___Black_rot",
  "Apple___Cedar_apple_rust",
  "Apple___healthy",
  "Blueberry___healthy",
  "Cherry_(including_sour)___Powdery_mildew",
  "Cherry_(including_sour)___healthy",
  "Corn_(maize)___Cercospora_leaf_spot Gray_leaf_spot",
  "Corn_(maize)___Common_rust_",
  "Corn_(maize)___Northern_Leaf_Blight",
  "Corn_(maize)___healthy",
  "Grape___Black_rot",
  "Grape___Esca_(Black_Measles)",
  "Grape___Leaf_blight_(Isariopsis_Leaf_Spot)",
  "Grape___healthy",
  "Orange___Haunglongbing_(Citrus_greening)",
  "Peach___Bacterial_spot",
  "Peach___healthy",
  "Pepper,_bell___Bacterial_spot",
  "Pepper,_bell___healthy",
  "Potato___Early_blight",
  "Potato___Late_blight",
  "Potato___healthy",
  "Raspberry___healthy",
  "Soybean___healthy",
  "Squash___Powdery_mildew",
  "Strawberry___Leaf_scorch",
  "Strawberry___healthy",
  "Tomato___Bacterial_spot",
  "Tomato___Early_blight",
  "Tomato___Late_blight",
  "Tomato___Leaf_Mold",
  "Tomato___Septoria_leaf_spot",
  "Tomato___Spider_mites Two-spotted_spider_mite",
  "Tomato___Target_Spot",
  "Tomato___Tomato_Yellow_Leaf_Curl_Virus",
  "Tomato___Tomato_mosaic_virus",
  "Tomato___healthy",
] as const;

test("DISEASE_TAXONOMY maps every PlantVillage class to a crop and symptoms", () => {
  const keys = Object.keys(DISEASE_TAXONOMY);
  assert.equal(keys.length, PLANTVILLAGE_CLASSES.length);
  for (const label of PLANTVILLAGE_CLASSES) {
    const entry = DISEASE_TAXONOMY[label];
    assert.ok(entry, `missing taxonomy row for ${label}`);
    assert.equal(typeof entry.crop, "string");
    assert.ok(entry.crop.length > 0, `${label} has no Arabic crop`);
    assert.equal(typeof entry.cropKey, "string");
    assert.ok(Array.isArray(entry.symptoms), `${label} symptoms must be an array`);
  }
  // The spec's own example row.
  assert.deepEqual(DISEASE_TAXONOMY["Tomato___Bacterial_spot"], {
    crop: "طماطم",
    cropKey: "tomato",
    symptoms: DISEASE_TAXONOMY["Tomato___Bacterial_spot"].symptoms,
  });
  assert.ok(
    DISEASE_TAXONOMY["Tomato___Bacterial_spot"].symptoms.some((symptom) => symptom.includes("بقع")),
  );
});

test("the wizard offers exactly the mandated crops plus the unknown escape hatch", () => {
  assert.deepEqual([...CLARIFICATION_CROP_OPTIONS], [
    "طماطم",
    "بطاطس",
    "عنب",
    "تفاح",
    "خوخ",
    "غير ذلك",
  ]);
  assert.deepEqual(buildClarificationQuestions(), [
    {
      id: "crop",
      question: "ما هو نوع هذا النبات؟",
      options: ["طماطم", "بطاطس", "عنب", "تفاح", "خوخ", "غير ذلك"],
    },
  ]);
  // A fresh copy each time — callers may not mutate the shared questionnaire.
  const [first] = buildClarificationQuestions();
  first.options.push("نبات آخر");
  assert.equal(buildClarificationQuestions()[0].options.length, 6);
});

/* ------------------------------------------------------------------ */
/*  Answer resolution                                                  */
/* ------------------------------------------------------------------ */

test("resolveCropKey accepts Arabic spellings, definite articles and French/English names", () => {
  assert.equal(resolveCropKey("طماطم"), "tomato");
  assert.equal(resolveCropKey("الطماطم"), "tomato");
  assert.equal(resolveCropKey("طماطم 🍅"), "tomato");
  assert.equal(resolveCropKey("طماطة"), "tomato");
  assert.equal(resolveCropKey("tomate"), "tomato");
  assert.equal(resolveCropKey("بطاطس"), "potato");
  assert.equal(resolveCropKey("البطاطا"), "potato");
  assert.equal(resolveCropKey("عنب"), "grape");
  assert.equal(resolveCropKey("تفاح"), "apple");
  assert.equal(resolveCropKey("خوخ"), "peach");
});

test("resolveCropKey treats 'غير ذلك' and unknown answers as 'no filtering'", () => {
  assert.equal(resolveCropKey("غير ذلك"), null);
  assert.equal(resolveCropKey(""), null);
  assert.equal(resolveCropKey("   "), null);
  assert.equal(resolveCropKey(undefined), null);
  assert.equal(resolveCropKey("نبات غريب"), null);
});

test("cropKeyForLabel is robust to casing and separator variants", () => {
  assert.equal(cropKeyForLabel("Tomato___Early_blight"), "tomato");
  assert.equal(cropKeyForLabel("tomato bacterial spot"), "tomato");
  assert.equal(cropKeyForLabel("POTATO___LATE_BLIGHT"), "potato");
  assert.equal(cropKeyForLabel("Grape___healthy"), "grape");
  assert.equal(cropKeyForLabel("some-random-endpoint-label"), null);
  assert.equal(taxonomyForLabel("Potato___Late_blight")?.crop, "بطاطس");
});

/* ------------------------------------------------------------------ */
/*  Logit masking + recalculation                                      */
/* ------------------------------------------------------------------ */

const TOMATO_15_BEHIND_POTATO_45: RawPrediction[] = [
  { label: "Potato___Late_blight", score: 0.45 },
  { label: "Tomato___Early_blight", score: 0.15 },
  { label: "Grape___Black_rot", score: 0.1 },
];

test("VALIDATION: a 15% tomato class behind a 45% potato class is boosted to Top-1", () => {
  const filtered = applyTaxonomyFilter(TOMATO_15_BEHIND_POTATO_45, { crop: "طماطم" });

  // Every non-tomato class is gone.
  assert.deepEqual(
    filtered.map((row) => row.label),
    ["Tomato___Early_blight"],
  );
  // 0.15 ÷ (sum of the surviving raw scores = 0.15) → the true relative
  // probability: 100%, not the 15% that lost to an unrelated plant.
  assert.equal(filtered[0].rawScore, 0.15);
  assert.equal(filtered[0].score, 1);
  assert.equal(filtered[0].crop, "طماطم");
  assert.equal(filtered[0].cropKey, "tomato");
  assert.ok(filtered[0].symptoms.length > 0);
});

test("VALIDATION: masking flips the winner and the report records the flip", () => {
  const filtered = applyTaxonomyFilter(TOMATO_15_BEHIND_POTATO_45, { crop: "طماطم" });
  const report = buildFilterReport(TOMATO_15_BEHIND_POTATO_45, filtered, { crop: "طماطم" });

  assert.equal(report.applied, true);
  assert.equal(report.crop, "طماطم");
  assert.equal(report.cropKey, "tomato");
  assert.equal(report.totalClasses, 3);
  assert.equal(report.matchedClasses, 1);
  assert.equal(report.droppedClasses, 2);
  assert.equal(report.topLabelBefore, "Potato___Late_blight");
  assert.equal(report.topScoreBefore, 0.45);
  assert.equal(report.topLabelAfter, "Tomato___Early_blight");
  assert.equal(report.topScoreAfter, 1);
  assert.equal(report.changedTop, true);
  assert.equal(report.answer, "طماطم");
});

test("several classes of the chosen crop share the recalculated probability mass", () => {
  const raw: RawPrediction[] = [
    { label: "Potato___Late_blight", score: 0.45 },
    { label: "Tomato___Early_blight", score: 0.15 },
    { label: "Tomato___Late_blight", score: 0.05 },
    { label: "Tomato___healthy", score: 0.02 },
  ];
  const filtered = applyTaxonomyFilter(raw, { crop: "طماطم" });

  assert.deepEqual(
    filtered.map((row) => row.label),
    ["Tomato___Early_blight", "Tomato___Late_blight", "Tomato___healthy"],
  );
  const total = filtered.reduce((sum, row) => sum + row.score, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
  assert.equal(filtered[0].score, 0.15 / 0.22);
  assert.equal(filtered[1].score, 0.05 / 0.22);
  assert.equal(filtered[2].score, 0.02 / 0.22);
  // Descending order is guaranteed after recalculation too.
  assert.ok(filtered[0].score >= filtered[1].score);
  assert.ok(filtered[1].score >= filtered[2].score);
});

test("masking renormalises even when no class is dropped (the whole vector is that crop)", () => {
  const raw: RawPrediction[] = [
    { label: "Tomato___Early_blight", score: 0.3 },
    { label: "Tomato___Late_blight", score: 0.2 },
    { label: "Tomato___healthy", score: 0.1 },
  ];
  const filtered = applyTaxonomyFilter(raw, { crop: "طماطم" });
  const scores = filtered.map((row) => row.score);
  const expected = [0.5, 1 / 3, 1 / 6];
  scores.forEach((score, index) => assert.ok(Math.abs(score - expected[index]) < 1e-9));
  const report = buildFilterReport(raw, filtered, { crop: "طماطم" });
  assert.equal(report.applied, true);
  assert.equal(report.matchedClasses, 3);
  assert.equal(report.droppedClasses, 0);
});

test("'غير ذلك' leaves MobileNetV2's own ranking and scores untouched", () => {
  for (const answer of ["غير ذلك", "", undefined, "نبتة مجهولة"]) {
    const filtered = applyTaxonomyFilter(TOMATO_15_BEHIND_POTATO_45, { crop: answer });
    assert.deepEqual(
      filtered.map((row) => [row.label, row.score]),
      [
        ["Potato___Late_blight", 0.45],
        ["Tomato___Early_blight", 0.15],
        ["Grape___Black_rot", 0.1],
      ],
    );
    assert.ok(filtered.every((row) => row.rawScore === row.score));
    const report = buildFilterReport(TOMATO_15_BEHIND_POTATO_45, filtered, { crop: answer });
    assert.equal(report.applied, false);
    assert.equal(report.cropKey, null);
    assert.equal(report.changedTop, false);
  }
});

test("a crop with no predicted class falls back to the model's own ranking", () => {
  const filtered = applyTaxonomyFilter(TOMATO_15_BEHIND_POTATO_45, { crop: "تفاح" });
  // Nothing of the apple family was predicted: masking would empty the
  // pipeline, so the raw vector survives (scores untouched) for the route to
  // flag as "التصفية تعذّرت".
  assert.deepEqual(
    filtered.map((row) => row.label),
    ["Potato___Late_blight", "Tomato___Early_blight", "Grape___Black_rot"],
  );
  const report = buildFilterReport(TOMATO_15_BEHIND_POTATO_45, filtered, { crop: "تفاح" });
  assert.equal(report.applied, false);
  assert.equal(report.matchedClasses, 0);
  assert.equal(report.topLabelAfter, "Potato___Late_blight");
});

test("masking drops malformed rows and never divides by zero", () => {
  const raw = [
    { label: "Tomato___Early_blight", score: 0.4 },
    { label: "", score: 0.3 },
    { label: "Tomato___Late_blight", score: Number.NaN },
    { label: "Tomato___healthy", score: -0.2 },
    { label: "Potato___Late_blight", score: 0.2 },
  ] as RawPrediction[];
  const filtered = applyTaxonomyFilter(raw, { crop: "طماطم" });
  assert.deepEqual(
    filtered.map((row) => row.label),
    ["Tomato___Early_blight"],
  );
  assert.equal(filtered[0].score, 1);

  // A vector of only zero-scored classes is left alone instead of NaN-ing.
  const zeros: RawPrediction[] = [
    { label: "Tomato___Early_blight", score: 0 },
    { label: "Potato___Late_blight", score: 0 },
  ];
  const zeroFiltered = applyTaxonomyFilter(zeros, { crop: "طماطم" });
  assert.ok(zeroFiltered.every((row) => Number.isFinite(row.score)));

  assert.deepEqual(applyTaxonomyFilter([], { crop: "طماطم" }), []);
  assert.deepEqual(applyTaxonomyFilter(null, { crop: "طماطم" }), []);
});

test("equal raw scores keep the model's own ordering (stable sort)", () => {
  const raw: RawPrediction[] = [
    { label: "Tomato___Early_blight", score: 0.2 },
    { label: "Tomato___Late_blight", score: 0.2 },
  ];
  const filtered = applyTaxonomyFilter(raw, { crop: "طماطم" });
  assert.deepEqual(
    filtered.map((row) => row.label),
    ["Tomato___Early_blight", "Tomato___Late_blight"],
  );
  assert.deepEqual(
    filtered.map((row) => row.score),
    [0.5, 0.5],
  );
});
