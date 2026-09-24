/**
 * Phenology helper — the growth stage that feeds the daily-task context.
 *
 * The app has no crop-calendar backend yet, so the stage is a deterministic
 * month × crop-group lookup over the usual Algerian seasons (cereals sown in
 * autumn, market-garden crops in spring, tree crops following the olive /
 * citrus calendar, date palm around the Ghez / Kimri / Rutab / Tamr cycle).
 * Pure and locale-free — bilingual labels, no network, same result on server
 * and client (which the 23:55 snapshot and the on-device fallback both need).
 */

import type { CropKey } from "../wilayas";

export interface GrowthStage {
  ar: string;
  fr: string;
}

/** Crop groups sharing one phenology calendar. */
export type CropGroup = "cereal" | "vegetable" | "tree" | "palm" | "forage" | "warmField";

const GROUP: Record<CropKey, CropGroup> = {
  wheat: "cereal",
  barley: "cereal",
  faba: "cereal",
  pea: "cereal",
  tomato: "vegetable",
  potato: "vegetable",
  onion: "vegetable",
  pepper: "vegetable",
  carrot: "vegetable",
  garlic: "vegetable",
  melon: "vegetable",
  watermelon: "vegetable",
  artichoke: "vegetable",
  olive: "tree",
  citrus: "tree",
  grape: "tree",
  apple: "tree",
  peach: "tree",
  apricot: "tree",
  pomegranate: "tree",
  fig: "tree",
  almond: "tree",
  dates: "palm",
  alfalfa: "forage",
  alfa: "forage",
  sorghum: "warmField",
  sunflower: "warmField",
  rice: "warmField",
  groundnut: "warmField",
  chickpea: "warmField",
  lentil: "warmField",
  henna: "warmField",
};

/** 12 month slots (0 = January … 11 = December). */
type Year = [GrowthStage, GrowthStage, GrowthStage, GrowthStage, GrowthStage, GrowthStage, GrowthStage, GrowthStage, GrowthStage, GrowthStage, GrowthStage, GrowthStage];

const st = (ar: string, fr: string): GrowthStage => ({ ar, fr });

const CALENDAR: Record<CropGroup, Year> = {
  // Autumn-sown cereals: حبور → إنبات → تشجير → إشراط → إسبال → نضج/حصاد → راحة.
  cereal: [
    st("مرحلة التشجير", "Tallage"),
    st("الإشراط", "Élongation"),
    st("الإشراط – الإسبال", "Montaison"),
    st("الإسبال وتعبئة الحبوب", "Épiaison – remplissage"),
    st("نضج الحبوب", "Maturation"),
    st("الحصاد", "Récolte"),
    st("راحة التربة", "Jachère"),
    st("راحة التربة", "Jachère"),
    st("تجهيز الأرض والحبور", "Préparation – semis"),
    st("الحبور والإنبات", "Semis – levée"),
    st("الإنبات المبكر", "Levée"),
    st("الإنبات والتشجير", "Levée – tallage"),
  ],
  // Market-garden crops (autumn plantations in the north, spring everywhere).
  vegetable: [
    st("حماية شتوية", "Protection hivernale"),
    st("نمو خضري", "Croissance végétative"),
    st("الإزهار", "Floraison"),
    st("عقد الثمار", "Nouaison"),
    st("تعبئة الثمار", "Grossissement des fruits"),
    st("نضج وحصاد", "Mûrissement – récolte"),
    st("ذروة الحصاد", "Pleine récolte"),
    st("إعادة الزراعة", "Nouvelle implantation"),
    st("التأسيس", "Implantation"),
    st("النمو المبكر", "Croissance précoce"),
    st("النمو الخضري", "Croissance végétative"),
    st("نمو مبكر محمي", "Croissance sous abri"),
  ],
  // Fruit trees + olive + vine: the classic Mediterranean cycle.
  tree: [
    st("راحة نباتية", "Repos végétatif"),
    st("راحة نباتية وتقليم", "Repos – taille"),
    st("التفاتح والإزهار", "Débourrement – floraison"),
    st("الإزهار وعقد الثمار", "Floraison – nouaison"),
    st("عقد الثمار", "Nouaison"),
    st("تعبئة الثمار", "Grossissement des fruits"),
    st("تعبئة وتلون", "Grossissement – véraison"),
    st("نضج الثمار", "Maturation"),
    st("نضج وبداية الحصاد", "Maturation – début de récolte"),
    st("الحصاد", "Récolte"),
    st("ما بعد الحصاد", "Post-récolte"),
    st("راحة نباتية", "Repos végétatif"),
  ],
  // Date palm — عناية وتنظيف → تفتح ولقاح → عقد (كيمري) → رطب → تمر وجذاذ.
  palm: [
    st("عناية وتنظيف النخيل", "Entretien des palmiers"),
    st("عناية وتهيئة للتفاتح", "Préparation à la floraison"),
    st("التفاتح وبداية اللقاح", "Débourrement – pollinisation"),
    st("اللقاح وعقد الثمار", "Pollinisation – nouaison"),
    st("عقد الجذاذ", "Nouaison (Kimri)"),
    st("مرحلة الكيمري", "Kimri"),
    st("بداية الرطب", "Début de Rutab"),
    st("الرطب", "Rutab"),
    st("نضج التمر", "Mûrissement (Tamr)"),
    st("الجذاذ والحصاد", "Récolte des dattes"),
    st("الحصاد وتجفيف التمر", "Récolte – séchage"),
    st("راحة وتنظيف", "Repos – nettoyage"),
  ],
  // Alfalfa / alfa — قصّات متكررة في الموسم الأخضر.
  forage: [
    st("راحة وتسميد أخضر", "Repos – fertilisation"),
    st("بداية الإنبات", "Reprise de végétation"),
    st("نمو خضري", "Croissance végétative"),
    st("القصّة الأولى", "Première coupe"),
    st("القصّة الثانية", "Deuxième coupe"),
    st("القصّة الثالثة", "Troisième coupe"),
    st("القصّة الرابعة", "Quatrième coupe"),
    st("القصّة الخامسة", "Cinquième coupe"),
    st("القصّة الأخيرة", "Dernière coupe"),
    st("التخضير", "Reprise de végétation"),
    st("نمو خضري متأخر", "Croissance tardive"),
    st("راحة شتوية", "Repos hivernal"),
  ],
  // Warm-season field crops (sorghum, sunflower, chickpea, lentil…).
  warmField: [
    st("راحة وتخطيط الموسم", "Planification de saison"),
    st("راحة التربة", "Jachère"),
    st("تجهيز الأرض", "Préparation du sol"),
    st("الحبور", "Semis"),
    st("الإنبات والتشجير", "Levée – tallage"),
    st("نمو خضري", "Croissance végétative"),
    st("الإزهار", "Floraison"),
    st("تعبئة الحبوب/الثمار", "Remplissage"),
    st("النضج", "Maturation"),
    st("الحصاد", "Récolte"),
    st("ما بعد الحصاد", "Post-récolte"),
    st("راحة التربة", "Jachère"),
  ],
};

/**
 * Growth stage of `crop` in the given month (0 = January). Deterministic —
 * the same month always yields the same stage for a given crop. Both language
 * labels ship together (`ar` / `fr`).
 */
export function growthStageFor(crop: CropKey, month: number): GrowthStage {
  const group = GROUP[crop] ?? "warmField";
  const index = ((month % 12) + 12) % 12;
  return CALENDAR[group][index];
}

/** Exposed for tests and the AI prompt ("crop group: …"). */
export function cropGroupFor(crop: CropKey): CropGroup {
  return GROUP[crop] ?? "warmField";
}
