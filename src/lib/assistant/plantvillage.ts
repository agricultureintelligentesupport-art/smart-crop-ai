/**
 * PlantVillage label → Arabic localisation.
 *
 * The Hugging Face classifiers trained on the PlantVillage dataset emit
 * labels shaped like `Tomato___Late_blight`, `Corn_(maize)___Common_rust_` or
 * `Apple___healthy` (exact casing/underscores vary per checkpoint). This
 * module parses those labels robustly and maps both halves to natural Arabic
 * so the UI and the LLM prompt can talk about "الطماطم — اللفحة المتأخرة"
 * instead of a raw machine label.
 *
 * Server-safe: no browser APIs, no React.
 */

export interface ParsedPlantLabel {
  /** Raw label as returned by the model. */
  raw: string;
  cropAr: string | null;
  diseaseAr: string | null;
  healthy: boolean;
  /** "الطماطم — اللفحة المتأخرة" or the raw label when unknown. */
  labelAr: string;
}

/** Lowercased, alphanumeric-only key for fuzzy matching. */
function norm(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const CROPS_AR: Record<string, string> = {
  apple: "التفاح",
  blueberry: "التوت الأزرق",
  cherry: "الكرز",
  corn: "الذرة",
  maize: "الذرة",
  grape: "العنب",
  orange: "البرتقال",
  peach: "الخوخ",
  pepper: "الفلفل",
  "bell pepper": "الفلفل الحلو",
  potato: "البطاطا",
  raspberry: "التوت",
  soybean: "فول الصويا",
  squash: "القرع",
  strawberry: "الفراولة",
  tomato: "الطماطم",
  wheat: "القمح",
  rice: "الأرز",
  cotton: "القطن",
  cucumber: "الخيار",
};

/** Keys are `norm()`-ed disease fragments; order matters (longest first). */
const DISEASES_AR: [string, string][] = [
  ["cedar apple rust", "صدأ التفاح والعرعر"],
  ["apple scab", "جرب التفاح"],
  ["scab", "الجرب"],
  ["black rot", "العفن الأسود"],
  ["powdery mildew", "البياض الدقيقي"],
  ["cercospora leaf spot gray leaf spot", "التبقع الرمادي للأوراق (سركوسبورا)"],
  ["gray leaf spot", "التبقع الرمادي للأوراق"],
  ["cercospora", "تبقع السركوسبورا"],
  ["common rust", "الصدأ الشائع"],
  ["northern leaf blight", "اللفحة الشمالية للأوراق"],
  ["esca black measles", "مرض الإسكا (الحصبة السوداء)"],
  ["esca", "مرض الإسكا"],
  ["leaf blight isariopsis leaf spot", "لفحة الأوراق (تبقع إيزاريوبسيس)"],
  ["haunglongbing citrus greening", "مرض التخضير (هوانغلونغبينغ)"],
  ["haunglongbing", "مرض التخضير (هوانغلونغبينغ)"],
  ["bacterial spot", "التبقع البكتيري"],
  ["early blight", "اللفحة المبكرة"],
  ["late blight", "اللفحة المتأخرة"],
  ["leaf mold", "عفن الأوراق"],
  ["septoria leaf spot", "تبقع السبتوريا"],
  ["spider mites two spotted spider mite", "العنكبوت الأحمر (الأكاروس ذو البقعتين)"],
  ["spider mites", "العنكبوت الأحمر (الأكاروس)"],
  ["target spot", "التبقع الهدفي"],
  ["yellow leaf curl virus", "فيروس تجعّد واصفرار الأوراق"],
  ["mosaic virus", "فيروس الموزاييك (التبرقش)"],
  ["leaf scorch", "لسعة (احتراق) الأوراق"],
  ["leaf blight", "لفحة الأوراق"],
  ["leaf spot", "تبقع الأوراق"],
  ["blight", "اللفحة"],
  ["rust", "الصدأ"],
  ["rot", "التعفن"],
  ["virus", "إصابة فيروسية"],
  ["mildew", "البياض"],
];

/** Parse a raw PlantVillage-style label into crop + disease, localised. */
export function parsePlantLabel(rawLabel: string): ParsedPlantLabel {
  const raw = rawLabel.trim();
  // "Tomato___Late_blight" → crop side / disease side.
  const [cropSide, ...rest] = raw.split(/_{2,}/);
  const diseaseSide = rest.join(" ");
  const cropNorm = norm(cropSide ?? "");
  // When the label has no `___` separator, the crop is usually the first word.
  const wholeNorm = norm(raw);
  const diseaseNorm = diseaseSide ? norm(diseaseSide) : wholeNorm;

  let cropAr: string | null = null;
  for (const [key, ar] of Object.entries(CROPS_AR)) {
    if (cropNorm.includes(key) || wholeNorm.startsWith(key)) {
      cropAr = ar;
      break;
    }
  }

  const healthy = /healthy/.test(wholeNorm);
  let diseaseAr: string | null = null;
  if (!healthy) {
    for (const [key, ar] of DISEASES_AR) {
      if (diseaseNorm.includes(key) || wholeNorm.includes(key)) {
        diseaseAr = ar;
        break;
      }
    }
  }

  let labelAr: string;
  if (healthy) {
    labelAr = cropAr ? `${cropAr} — نبتة سليمة ✅` : "نبتة سليمة ✅";
  } else if (cropAr && diseaseAr) {
    labelAr = `${cropAr} — ${diseaseAr}`;
  } else if (diseaseAr) {
    labelAr = diseaseAr;
  } else {
    labelAr = raw.replace(/_{2,}/g, " — ").replace(/_/g, " ");
  }

  return { raw, cropAr, diseaseAr, healthy, labelAr };
}

/**
 * Crop names that may prefix or suffix a diagnosis string. Arabic values come
 * from {@link CROPS_AR}; English keys cover PlantVillage crop sides such as
 * `Corn (maize)` and `Pepper, bell`. Comparison is accent- and harakat-folded.
 */
const CROP_AR_KEYS = new Set(
  [...Object.values(CROPS_AR), "بطاطس", "بندورة", "بندوره", "مايس", "مايز"].map((name) => foldArCrop(name)),
);
const CROP_LATIN_KEYS = new Set(
  [
    ...Object.keys(CROPS_AR),
    "tomate",
    "pomme de terre",
    "mais",
    "ble",
    "pomme",
    "raisin",
    "poivron",
    "piment",
    "fraise",
    "courge",
    "soja",
    "cerise",
    "peche",
    "orange",
    "coton",
    "concombre",
    "riz",
    "bleuet",
    "framboise",
  ].map((name) => norm(foldLatin(name))),
);
/** Words that may sit beside a crop on a PlantVillage crop side, but are not diseases. */
const CROP_SIDE_FILLERS = new Set(["including", "sour", "bell", "sweet", "and", "plant", "crop", "species"]);

function foldLatin(input: string): string {
  return input.normalize("NFD").replace(/\p{M}/gu, "");
}

function foldAr(input: string): string {
  return input
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[\u064B-\u0652\u0640\u0670]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function foldArCrop(input: string): string {
  return foldAr(input).replace(/^ال/, "");
}

/** True when a label segment is only a plant species (optionally with a variety qualifier). */
function isCropFragment(fragment: string): boolean {
  const cleaned = fragment
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    .replace(/^(?:محصول|نبات|نبتة|زراعة)\s+/u, "")
    .replace(/^(?:crop|plant|species)\s+/iu, "")
    .replace(/\s+(?:crop|plant|species)$/iu, "")
    .trim();
  if (!cleaned) return false;

  const ar = foldArCrop(cleaned.replace(/^(?:مرض|اصابة|إصابة)\s+/u, ""));
  if (ar && CROP_AR_KEYS.has(ar)) return true;

  const latin = norm(foldLatin(cleaned));
  if (!latin) return false;
  if (CROP_LATIN_KEYS.has(latin)) return true;
  const words = latin.split(" ").filter(Boolean);
  return (
    words.length > 0 &&
    words.every((word) => CROP_LATIN_KEYS.has(word) || CROP_SIDE_FILLERS.has(word)) &&
    words.some((word) => CROP_LATIN_KEYS.has(word))
  );
}

const LABEL_SEGMENT_SPLIT = /\s*(?:—|–|―|‒|−|_{2,}|[:：])\s*|\s+[-/|]\s+/u;

function splitLabelSegments(label: string): string[] {
  return label
    .split(LABEL_SEGMENT_SPLIT)
    .map((part) => part.trim())
    .filter(Boolean);
}

function dropCropSegments(label: string): string {
  const parts = splitLabelSegments(label);
  if (parts.length < 2) return label;
  const kept = parts.filter((part) => !isCropFragment(part));
  if (kept.length === 0 || kept.length === parts.length) return label;
  return kept.join(" — ");
}

function stripEdgeParentheticalCrops(label: string): string {
  let text = label;
  let previous = "";
  while (text !== previous) {
    previous = text;
    text = text
      .replace(/^\s*[(\[（]\s*([^)\]）]+)\s*[)\]）]\s*/u, (full, inner: string) =>
        isCropFragment(inner) ? "" : full,
      )
      .replace(/\s*[(\[（]\s*([^)\]）]+)\s*[)\]）]\s*$/u, (full, inner: string) =>
        isCropFragment(inner) ? "" : full,
      )
      .trim();
  }
  return text;
}

/**
 * Remove plant-species prefixes and suffixes from a diagnosis display string.
 * "الذرة — التبقّع الرمادي للأوراق" → "التبقّع الرمادي للأوراق".
 * Official disease names that merely mention a host ("جرب التفاح") are kept.
 */
function stripCropAffixes(label: string): string {
  let text = label.replace(/✅/g, "").replace(/\s+/g, " ").trim();
  if (!text) return "";

  text = stripEdgeParentheticalCrops(text);
  text = dropCropSegments(text);
  // Hyphenated crop sides ("Corn-Common rust") — only when a segment is a crop,
  // so disease tokens like "leaf-spot" stay intact.
  if (!text.includes(" — ")) {
    const hyphenParts = text.split(/\s*-\s*/).map((part) => part.trim()).filter(Boolean);
    if (hyphenParts.length >= 2) {
      const kept = hyphenParts.filter((part) => !isCropFragment(part));
      if (kept.length > 0 && kept.length < hyphenParts.length) text = kept.join(" — ");
    }
  }
  text = stripEdgeParentheticalCrops(text);

  text = text
    .replace(/\s+(?:of|on|in|for|chez|du|de la|de l'|des)\s+([A-Za-z][^—–]{0,48})$/i, (full, crop: string) =>
      isCropFragment(crop) ? "" : full,
    )
    .replace(/\s+(?:في|على|لدى)\s+([\u0600-\u06FF][\u0600-\u06FF\s]{1,40})$/u, (full, crop: string) =>
      isCropFragment(crop) ? "" : full,
    )
    .trim();

  return text.replace(/\s+/g, " ").trim();
}

/** Whole-phrase match on an already-normalised English string. */
function includesPhrase(haystack: string, phrase: string): boolean {
  const needle = norm(phrase);
  if (!needle) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

/**
 * Translate a prose English diagnosis ("Corn (Maize) with Common Rust",
 * "Healthy Corn (Maize) Plant") to an Arabic disease-only name. Returns null
 * when the string is not English or names no known disease / healthy state.
 */
function arabicDiseaseFromProse(source: string): string | null {
  if (!/[A-Za-z]/.test(source)) return null;
  const folded = norm(foldLatin(source));
  if (!folded) return null;
  for (const [key, ar] of DISEASES_AR) {
    if (includesPhrase(folded, key)) return stripCropAffixes(ar) || ar;
  }
  if (includesPhrase(folded, "healthy")) return "نبتة سليمة";
  return null;
}

/** Drop "Corn (Maize) with …" / trailing "Plant" when no disease key matched. */
function stripEnglishCropProse(source: string): string {
  let text = source.replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
  const withParts = text.split(/\s+with\s+/i);
  if (withParts.length >= 2 && isCropFragment(withParts[0])) {
    text = withParts.slice(1).join(" with ");
  }
  text = text
    .replace(/^(?:healthy|diseased)\s+/i, "")
    .replace(/\s+plant$/i, "")
    .trim();
  return stripCropAffixes(text);
}

/**
 * Disease-only diagnosis name.
 *
 * Accepts a raw PlantVillage label (`Corn_(maize)___Common_rust_`), a prose
 * English candidate (`Corn (Maize) with Common Rust`, `Healthy Corn (Maize) Plant`)
 * or an already localised string (`الذرة — الصدأ الشائع`) and returns just the
 * disease (`الصدأ الشائع` / `نبتة سليمة`). Custom spellings on an already-localised
 * string are preserved (the crop affix is stripped, the disease half is not
 * re-translated).
 */
export function diseaseOnlyName(source: string): string {
  const trimmed = source.trim();
  if (!trimmed) return "";

  if (/_{2,}/.test(trimmed)) {
    const parsed = parsePlantLabel(trimmed);
    if (parsed.healthy) return "نبتة سليمة";
    if (parsed.diseaseAr) return stripCropAffixes(parsed.diseaseAr) || parsed.diseaseAr;
    const diseaseSide = trimmed
      .split(/_{2,}/)
      .slice(1)
      .join(" ")
      .replace(/_/g, " ")
      .replace(/✅/g, "")
      .trim();
    const translatedSide = arabicDiseaseFromProse(diseaseSide);
    if (translatedSide) return translatedSide;
    const strippedSide = stripCropAffixes(diseaseSide);
    if (strippedSide) return strippedSide;
  }

  const translated = arabicDiseaseFromProse(trimmed);
  if (translated) return translated;

  const base = /[A-Za-z]/.test(trimmed) ? stripEnglishCropProse(trimmed) : trimmed;
  const stripped = stripCropAffixes(base);
  const translatedRemainder = arabicDiseaseFromProse(stripped);
  if (translatedRemainder) return translatedRemainder;
  return stripped || trimmed.replace(/✅/g, "").trim();
}

/** Confidence bucket used for wording (server + UI share the thresholds). */
export function confidenceBucket(score: number): "high" | "medium" | "low" {
  if (score >= 0.75) return "high";
  if (score >= 0.45) return "medium";
  return "low";
}
