/**
 * PlantVillage label → Arabic localisation.
 *
 * The Hugging Face classifiers trained on the PlantVillage dataset emit
 * labels shaped like `Tomato___Late_blight`, `Corn_(maize)___Common_rust_` or
 * `Apple___healthy` (exact casing/underscores vary per checkpoint). This
 * module parses those labels robustly and maps both halves to natural Arabic
 * so the UI and the Gemini prompt can talk about "الطماطم — اللفحة المتأخرة"
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

/** Confidence bucket used for wording (server + UI share the thresholds). */
export function confidenceBucket(score: number): "high" | "medium" | "low" {
  if (score >= 0.75) return "high";
  if (score >= 0.45) return "medium";
  return "low";
}
