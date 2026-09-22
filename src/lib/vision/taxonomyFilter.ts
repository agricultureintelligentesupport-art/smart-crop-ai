/**
 * Interactive diagnosis — MobileNetV2 logit masking by disease taxonomy.
 *
 * MobileNetV2 (`linkanjarad/mobilenet_v2_1.0_224-plant-disease-identification`)
 * is the STRICT diagnostic authority of the pipeline: it emits one probability
 * per PlantVillage class (38 of them) and the route NEVER lets an LLM talk it
 * out of that verdict. The only thing the system is allowed to do with the
 * vector is MASK it: when the Top-1 confidence is low (< 90%) the farmer is
 * asked a single clarifying question — "ما هو نوع هذا النبات؟" — and the
 * classes that cannot belong to the chosen crop are dropped outright.
 *
 * Masking out the wrong-crop logits is a massive boost for the surviving
 * ones, because the softmax mass they were competing against is gone. The
 * masked vector is therefore RENORMALISED (each remaining raw score ÷ the sum
 * of the remaining raw scores), which turns a 15% "Tomato___Early_blight"
 * sitting behind a 45% "Potato___Late_blight" into a ~100% tomato verdict —
 * the true relative probability of the classes that are actually possible on
 * the photographed plant. The corresponding potato classes are the wrong
 * plant, so they are discarded rather than merely outranked.
 *
 * This module is deliberately dependency-free (no fetch, no React, no
 * `sharp`, no Arabic label parser) so the route handler, the client wizard and
 * `node --test` unit tests can all import it.
 *
 * Server- and client-safe: no browser APIs.
 */

/** One raw MobileNetV2 output row, exactly as the classifier returns it. */
export interface RawPrediction {
  /** Raw PlantVillage class, e.g. "Tomato___Bacterial_spot". */
  label: string;
  /** Raw softmax score in [0, 1]. */
  score: number;
}

/**
 * The farmer's answers from the interactive questionnaire (second pass).
 * Today only `crop` is asked; the record is open-ended so later questions
 * (leaf age, affected part…) can join without a contract change.
 */
export interface DiagnosisUserAnswers {
  /** Crop label the farmer picked, e.g. "طماطم" or "غير ذلك". */
  crop?: string | null;
  [questionId: string]: string | null | undefined;
}

/** Taxonomy row for one PlantVillage class. */
export interface TaxonomyEntry {
  /** Canonical Arabic crop name — matches the wizard options. */
  crop: string;
  /** Stable machine key for the crop ("tomato", "potato"…). */
  cropKey: string;
  /** Short Arabic visual symptoms of this specific disease (may be empty). */
  symptoms: string[];
}

/**
 * The PlantVillage taxonomy: every one of the 38 MobileNetV2 classes mapped to
 * the single crop it can possibly appear on, plus its short Arabic symptom
 * fingerprint (handed to the formatter LLM so its report talks about the
 * symptoms actually visible on this disease).
 */
export const DISEASE_TAXONOMY: Record<string, TaxonomyEntry> = {
  Apple___Apple_scab: {
    crop: "تفاح",
    cropKey: "apple",
    symptoms: ["بقع زيتونية مخملية على الأوراق", "تشقق وتشوه الثمار"],
  },
  Apple___Black_rot: {
    crop: "تفاح",
    cropKey: "apple",
    symptoms: ["بقع بنفسجية دائرية على الأوراق", "تعفن دائري غائر في الثمار"],
  },
  Apple___Cedar_apple_rust: {
    crop: "تفاح",
    cropKey: "apple",
    symptoms: ["بقع صفراء-برتقالية لامعة", "نقاط برتقالية بارزة على السطح السفلي"],
  },
  "Apple___healthy": { crop: "تفاح", cropKey: "apple", symptoms: [] },

  "Blueberry___healthy": { crop: "توت أزرق", cropKey: "blueberry", symptoms: [] },

  "Cherry_(including_sour)___Powdery_mildew": {
    crop: "كرز",
    cropKey: "cherry",
    symptoms: ["طبقة بيضاء دقيقية على الأوراق", "تجعد وتشوه الأوراق الحديثة"],
  },
  "Cherry_(including_sour)___healthy": { crop: "كرز", cropKey: "cherry", symptoms: [] },

  "Corn_(maize)___Cercospora_leaf_spot Gray_leaf_spot": {
    crop: "ذرة",
    cropKey: "corn",
    symptoms: ["بقع مستطيلة رمادية-بنية موازية للعروق", "جفاف الأوراق السفلية"],
  },
  "Corn_(maize)___Common_rust_": {
    crop: "ذرة",
    cropKey: "corn",
    symptoms: ["بثور بنية-محمرة على السطحين", "اصفرار حول البثور"],
  },
  "Corn_(maize)___Northern_Leaf_Blight": {
    crop: "ذرة",
    cropKey: "corn",
    symptoms: ["آفات طولية رمادية-خضراء", "جفاف الأوراق من الأسفل للأعلى"],
  },
  "Corn_(maize)___healthy": { crop: "ذرة", cropKey: "corn", symptoms: [] },

  Grape___Black_rot: {
    crop: "عنب",
    cropKey: "grape",
    symptoms: ["بقع بنية دائرية بحافة داكنة", "تيبس الحبات وتحولها إلى عناقيد جافة"],
  },
  "Grape___Esca_(Black_Measles)": {
    crop: "عنب",
    cropKey: "grape",
    symptoms: ["اصفرار واحتراق بين العروق", "ذبول مفاجئ وتشقق الألياف الخشبية"],
  },
  "Grape___Leaf_blight_(Isariopsis_Leaf_Spot)": {
    crop: "عنب",
    cropKey: "grape",
    symptoms: ["بقع بنية غير منتظمة على الحواف", "جفاف حواف الأوراق"],
  },
  "Grape___healthy": { crop: "عنب", cropKey: "grape", symptoms: [] },

  "Orange___Haunglongbing_(Citrus_greening)": {
    crop: "برتقال",
    cropKey: "orange",
    symptoms: ["اصفرار غير متماثل على الأوراق", "أوراق صغيرة وتشوه الثمار"],
  },

  Peach___Bacterial_spot: {
    crop: "خوخ",
    cropKey: "peach",
    symptoms: ["بقع بنفسجية-بنية صغيرة", "ثقوب وتشوه في الأوراق"],
  },
  "Peach___healthy": { crop: "خوخ", cropKey: "peach", symptoms: [] },

  "Pepper,_bell___Bacterial_spot": {
    crop: "فلفل",
    cropKey: "pepper",
    symptoms: ["بقع مائية بنية داكنة", "تندب وتشوه الأوراق والثمار"],
  },
  "Pepper,_bell___healthy": { crop: "فلفل", cropKey: "pepper", symptoms: [] },

  Potato___Early_blight: {
    crop: "بطاطس",
    cropKey: "potato",
    symptoms: ["بقع بنية بحلقات متداخلة (عين الثور)", "اصفرار الأوراق السفلية"],
  },
  Potato___Late_blight: {
    crop: "بطاطس",
    cropKey: "potato",
    symptoms: ["بقع مائية داكنة واسعة", "عفن أبيض قطني على حدود البقع"],
  },
  "Potato___healthy": { crop: "بطاطس", cropKey: "potato", symptoms: [] },

  "Raspberry___healthy": { crop: "توت العليق", cropKey: "raspberry", symptoms: [] },

  "Soybean___healthy": { crop: "فول الصويا", cropKey: "soybean", symptoms: [] },

  "Squash___Powdery_mildew": {
    crop: "قرع",
    cropKey: "squash",
    symptoms: ["طبقة بيضاء دقيقية على السطحين", "اصفرار الأوراق وجفافها"],
  },

  "Strawberry___Leaf_scorch": {
    crop: "فراولة",
    cropKey: "strawberry",
    symptoms: ["بقع أرجوانية-بنية صغيرة", "جفاف حواف الأوراق"],
  },
  "Strawberry___healthy": { crop: "فراولة", cropKey: "strawberry", symptoms: [] },

  "Tomato___Bacterial_spot": {
    crop: "طماطم",
    cropKey: "tomato",
    symptoms: ["بقع بنية صغيرة محاطة بهالة صفراء", "ثقوب وتشوه الأوراق"],
  },
  "Tomato___Early_blight": {
    crop: "طماطم",
    cropKey: "tomato",
    symptoms: ["بقع بنية بحلقات متداخلة (عين الثور)", "اصفرار وجفاف الأوراق السفلية"],
  },
  "Tomato___Late_blight": {
    crop: "طماطم",
    cropKey: "tomato",
    symptoms: ["بقع مائية رمادية-خضراء", "عفن أبيض قطني على السطح السفلي"],
  },
  "Tomato___Leaf_Mold": {
    crop: "طماطم",
    cropKey: "tomato",
    symptoms: ["بقع صفراء باهتة على السطح العلوي", "عفن مخملي أخضر-بني على السطح السفلي"],
  },
  "Tomato___Septoria_leaf_spot": {
    crop: "طماطم",
    cropKey: "tomato",
    symptoms: ["بقع رمادية صغيرة بحافة داكنة", "نقاط سوداء (أجسام ثمرية) في مركز البقع"],
  },
  "Tomato___Spider_mites Two-spotted_spider_mite": {
    crop: "طماطم",
    cropKey: "tomato",
    symptoms: ["تنقيط أصفر دقيق (نقاط مبيضة)", "خيوط عنكبوتية رقيقة وجفاف الأوراق"],
  },
  "Tomato___Target_Spot": {
    crop: "طماطم",
    cropKey: "tomato",
    symptoms: ["بقع بنية بحلقات متداخلة تتسع بسرعة", "تمزق وثقوب في الأوراق"],
  },
  "Tomato___Tomato_Yellow_Leaf_Curl_Virus": {
    crop: "طماطم",
    cropKey: "tomato",
    symptoms: ["تجعّد واصفرار حواف الأوراق", "تقزم النبتة وقلة العقد"],
  },
  "Tomato___Tomato_mosaic_virus": {
    crop: "طماطم",
    cropKey: "tomato",
    symptoms: ["تبرقش أخضر-أصفر (موزاييك)", "تشوه وصغر الأوراق الحديثة"],
  },
  "Tomato___healthy": { crop: "طماطم", cropKey: "tomato", symptoms: [] },
};

/**
 * The wizard options, verbatim from the product spec: the five crops that
 * cover the overwhelming majority of Algerian market gardens, plus an escape
 * hatch. "غير ذلك" means "unknown crop" and switches filtering off — the raw
 * MobileNetV2 ranking then stands untouched.
 */
export const CLARIFICATION_CROP_OPTIONS: readonly string[] = [
  "طماطم",
  "بطاطس",
  "عنب",
  "تفاح",
  "خوخ",
  "غير ذلك",
];

/** The "unknown crop" escape hatch — never filters anything out. */
export const OTHER_CROP_OPTION = "غير ذلك";

/** The single question the interactive diagnosis wizard asks. */
export const CLARIFICATION_CROP_QUESTION: { id: string; question: string; options: string[] } = {
  id: "crop",
  question: "ما هو نوع هذا النبات؟",
  options: [...CLARIFICATION_CROP_OPTIONS],
};

/** A wizard question the frontend renders and answers (second pass payload). */
export interface ClarificationQuestion {
  /** Answer key inside `userAnswers`, e.g. "crop". */
  id: string;
  question: string;
  options: string[];
}

/** Fresh copy of the clarification questionnaire (never the shared constant). */
export function buildClarificationQuestions(): ClarificationQuestion[] {
  return [{ ...CLARIFICATION_CROP_QUESTION, options: [...CLARIFICATION_CROP_OPTIONS] }];
}

/* ------------------------------------------------------------------ */
/*  Answer → crop key resolution                                       */
/* ------------------------------------------------------------------ */

/** Arabic/French/English spellings accepted for every crop key. */
const CROP_ALIASES: Record<string, string[]> = {
  apple: ["تفاح", "التفاح", "pomme"],
  blueberry: ["توت أزرق", "العنبية", "myrtille"],
  cherry: ["كرز", "الكرز", "cerise"],
  corn: ["ذرة", "الذرة", "maize", "mais"],
  grape: ["عنب", "العنب", "raisin"],
  orange: ["برتقال", "البرتقال", "حمضيات", "ليمون", "orange"],
  peach: ["خوخ", "الخوخ", "دراق", "peche"],
  pepper: ["فلفل", "الفلفل", "فليفلة", "poivron"],
  potato: ["بطاطس", "البطاطس", "بطاطا", "البطاطا", "pomme de terre"],
  raspberry: ["توت العليق", "framboise"],
  soybean: ["فول الصويا", "صويا", "soja"],
  squash: ["قرع", "القرع", "كوسة", "كوسا", "courge", "courgette"],
  strawberry: ["فراولة", "الفراولة", "fraise"],
  tomato: ["طماطم", "الطماطم", "طماطة", "بندورة", "tomate"],
};

/**
 * Canonical form used for every comparison: lowercase, diacritics removed,
 * alef/ya/ta-marbuta folded, leading definite article dropped, punctuation and
 * emoji stripped. "الطماطم" and "طماطم 🍅" both normalise to "طماطم".
 */
export function normalizeCropAnswer(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u064B-\u0652\u0640\u0670\u0300-\u036f]/g, "") // harakat, tatweel, combining marks
    .replace(/[أإآٱ]/g, "ا")
    .replace(/[ىي]/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[ؤئ]/g, "و")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^ال(?=\p{L})/u, "");
}

const NORMALIZED_ALIASES: { cropKey: string; alias: string }[] = Object.entries(CROP_ALIASES)
  .flatMap(([cropKey, aliases]) => aliases.map((alias) => ({ cropKey, alias: normalizeCropAnswer(alias) })))
  // Longest alias first so "توت العليق" wins over a bare "توت" fragment.
  .sort((a, b) => b.alias.length - a.alias.length);

/**
 * Resolve a farmer answer ("طماطم", "الطماطم", "tomate", "بطاطا"…) to the
 * canonical crop key, or `null` when the answer is empty, "غير ذلك" or simply
 * unrecognised (which the route treats as "no filtering").
 */
export function resolveCropKey(answer: string | null | undefined): string | null {
  if (typeof answer !== "string") return null;
  const normalized = normalizeCropAnswer(answer);
  if (!normalized) return null;
  if (normalized === normalizeCropAnswer(OTHER_CROP_OPTION)) return null;
  if (/^(غير|اخري|other|autre|unknown|none|لا اعرف)/.test(normalized)) return null;

  const exact = NORMALIZED_ALIASES.find((entry) => entry.alias === normalized);
  if (exact) return exact.cropKey;
  const partial = NORMALIZED_ALIASES.find(
    (entry) => entry.alias.length >= 3 && normalized.includes(entry.alias),
  );
  return partial ? partial.cropKey : null;
}

/** Normalised taxonomy key: "Tomato___Bacterial_spot" → "tomato bacterial spot". */
function normalizeLabelKey(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const TAXONOMY_BY_NORMALIZED_LABEL: Map<string, { label: string; entry: TaxonomyEntry }> = new Map(
  Object.entries(DISEASE_TAXONOMY).map(([label, entry]) => [
    normalizeLabelKey(label),
    { label, entry },
  ]),
);

/** Lowercased crop words of the raw label (`Tomato___…` → "tomato"). */
function labelCropWords(label: string): string {
  return normalizeLabelKey(label.split(/_{2,}/)[0] ?? label);
}

/**
 * Crop key for a raw class label: exact taxonomy hit first, then a soft scan
 * of the label's crop half so a checkpoint that spells a class differently
 * (case, parentheses, `_` vs spaces) still lands on the right crop. `null`
 * means "not a MobileNetV2 PlantVillage class we can place".
 */
export function cropKeyForLabel(label: string): string | null {
  const entry = DISEASE_TAXONOMY[label] ?? TAXONOMY_BY_NORMALIZED_LABEL.get(normalizeLabelKey(label))?.entry;
  if (entry) return entry.cropKey;
  const words = labelCropWords(label);
  if (!words) return null;
  for (const [cropKey, aliases] of Object.entries(CROP_ALIASES)) {
    if (aliases.some((alias) => words.includes(alias))) return cropKey;
  }
  return null;
}

/** Taxonomy row for a raw label (exact match, then normalised match). */
export function taxonomyForLabel(label: string): TaxonomyEntry | null {
  return (
    DISEASE_TAXONOMY[label] ??
    TAXONOMY_BY_NORMALIZED_LABEL.get(normalizeLabelKey(label))?.entry ??
    null
  );
}

/* ------------------------------------------------------------------ */
/*  Logit masking + recalculation                                      */
/* ------------------------------------------------------------------ */

/** One row of the masked/recalculated vector handed back to the pipeline. */
export interface FilteredPrediction extends RawPrediction {
  /** Raw MobileNetV2 score, BEFORE recalculation. */
  rawScore: number;
  /** Recalculated score: raw ÷ Σ(raw of the surviving classes). */
  score: number;
  /** Canonical Arabic crop of the surviving class. */
  crop: string | null;
  /** Machine crop key of the surviving class. */
  cropKey: string | null;
  /** Short Arabic symptoms of this class (empty for healthy). */
  symptoms: string[];
}

/** Robust parsing of whatever the classifier returned (arrays of {label,score}). */
function sanitizePredictions(predictions: readonly RawPrediction[] | null | undefined): RawPrediction[] {
  if (!Array.isArray(predictions)) return [];
  const cleaned: RawPrediction[] = [];
  for (const row of predictions) {
    if (!row || typeof row !== "object") continue;
    const label = typeof row.label === "string" ? row.label.trim() : "";
    const score = typeof row.score === "number" ? row.score : Number.NaN;
    if (!label || !Number.isFinite(score) || score < 0) continue;
    cleaned.push({ label, score });
  }
  return cleaned;
}

/** Stable descending sort (equal scores keep the model's own ordering). */
function sortDescending<T extends { score: number }>(rows: T[]): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => b.row.score - a.row.score || a.index - b.index)
    .map(({ row }) => row);
}

/** Decorate a raw row with its taxonomy crop/symptoms (score untouched). */
function toRow(prediction: RawPrediction): FilteredPrediction {
  const entry = taxonomyForLabel(prediction.label);
  return {
    label: prediction.label,
    score: prediction.score,
    rawScore: prediction.score,
    crop: entry?.crop ?? null,
    cropKey: entry?.cropKey ?? cropKeyForLabel(prediction.label),
    symptoms: entry?.symptoms ?? [],
  };
}

/**
 * Mask MobileNetV2's full prediction vector against the farmer's answers and
 * recalculate the surviving probabilities.
 *
 * 1. every class whose crop does NOT match `userAnswers.crop` is dropped —
 *    a "Potato___Late_blight" row can never describe a tomato plant;
 * 2. the raw scores of the surviving classes are summed, and each survivor's
 *    raw score is divided by that sum, restoring the relative probability the
 *    classes actually compete for (15% tomato behind 45% potato → 100%
 *    tomato);
 * 3. the survivors are returned highest-first.
 *
 * When the answer is missing, "غير ذلك" or unknown — or when NO class of that
 * crop was predicted at all — the vector is returned unmasked (still sorted,
 * scores left as the model emitted them) so the pipeline always has a ranked
 * verdict to work with; the route inspects `rawScore === score` / the returned
 * crop to decide whether masking actually applied.
 *
 * @param rawPredictions Full MobileNetV2 output array (all 38 classes).
 * @param userAnswers    Wizard answers; only `crop` is consumed today.
 */
export function applyTaxonomyFilter(
  rawPredictions: readonly RawPrediction[] | null | undefined,
  userAnswers?: DiagnosisUserAnswers | null,
): FilteredPrediction[] {
  const rows = sanitizePredictions(rawPredictions);
  if (rows.length === 0) return [];

  const cropKey = resolveCropKey(userAnswers?.crop ?? null);
  if (!cropKey) return sortDescending(rows.map(toRow));

  const surviving = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => cropKeyForLabel(row.label) === cropKey);

  // Nothing of that crop in the vector → masking would empty the pipeline;
  // hand back the model's own ranking instead of nothing at all.
  if (surviving.length === 0) return sortDescending(rows.map(toRow));

  const total = surviving.reduce((sum, { row }) => sum + row.score, 0);
  if (!(total > 0)) return sortDescending(rows.map(toRow));

  const recalculated = surviving.map(({ row }) => ({ ...toRow(row), score: row.score / total }));
  return sortDescending(recalculated);
}

/* ------------------------------------------------------------------ */
/*  Reporting                                                          */
/* ------------------------------------------------------------------ */

/** Transparency report of one masking pass, surfaced to the client. */
export interface DiagnosisFilterReport {
  /**
   * True when the answer resolved to a crop AND at least one raw class
   * belongs to it — i.e. the mask dropped/re-weighted logits. False means the
   * model's own ranking stood (unknown crop, or no class of that crop).
   */
  applied: boolean;
  /** Raw answer as the farmer picked it ("طماطم"). */
  answer: string | null;
  /** Canonical crop key ("tomato") or null when nothing was masked. */
  cropKey: string | null;
  /** Arabic crop of the surviving classes. */
  crop: string | null;
  /** How many classes from the raw vector belong to that crop. */
  matchedClasses: number;
  /** How many wrong-crop classes the mask removed. */
  droppedClasses: number;
  /** How many classes the raw vector contained in total. */
  totalClasses: number;
  /** Top-1 label BEFORE masking (MobileNetV2's own winner). */
  topLabelBefore: string | null;
  /** Top-1 raw score before masking. */
  topScoreBefore: number;
  /** Top-1 label after masking. */
  topLabelAfter: string | null;
  /** Recalculated Top-1 score after masking. */
  topScoreAfter: number;
  /** True when masking flipped the winner (the whole point of the wizard). */
  changedTop: boolean;
}

/** Build the {@link DiagnosisFilterReport} for one masked vector. */
export function buildFilterReport(
  rawPredictions: readonly RawPrediction[] | null | undefined,
  filtered: readonly FilteredPrediction[],
  userAnswers?: DiagnosisUserAnswers | null,
): DiagnosisFilterReport {
  const raw = sanitizePredictions(rawPredictions);
  const rawSorted = sortDescending(raw);
  const before = rawSorted[0] ?? null;
  const after = filtered[0] ?? null;
  const answer =
    typeof userAnswers?.crop === "string" && userAnswers.crop.trim() ? userAnswers.crop.trim() : null;
  const cropKey = resolveCropKey(answer);
  const matchedClasses = cropKey
    ? raw.filter((row) => cropKeyForLabel(row.label) === cropKey).length
    : 0;
  const applied = cropKey !== null && raw.length > 0 && matchedClasses > 0;

  return {
    applied,
    answer,
    cropKey: applied ? cropKey : null,
    crop: applied ? (after?.crop ?? null) : null,
    matchedClasses,
    droppedClasses: applied ? Math.max(0, raw.length - filtered.length) : 0,
    totalClasses: raw.length,
    topLabelBefore: before?.label ?? null,
    topScoreBefore: before?.score ?? 0,
    topLabelAfter: after?.label ?? null,
    topScoreAfter: after?.score ?? 0,
    changedTop: Boolean(before && after && before.label !== after.label),
  };
}
