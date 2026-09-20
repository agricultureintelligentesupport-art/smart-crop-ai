/**
 * Algerian wilayas (58) with the agro-climatic baseline used to seed the
 * first weather + crop settings after onboarding.
 *
 * Numbers are *seasonal reference baselines* (early-autumn, 09), aggregated
 * from long-term climate normals for each province — they are deliberately
 * static so the app is fully offline-capable and deterministic. Swap
 * `climateFor()` for a live weather provider by keeping the same shape.
 */

export type Lang = "ar" | "fr";

export type WilayaRegion = "coast" | "tell" | "steppe" | "sahara";

export interface Bilingual {
  ar: string;
  fr: string;
}

export const REGIONS: Record<WilayaRegion, Bilingual> = {
  coast: { ar: "الساحل", fr: "Littoral" },
  tell: { ar: "التل الداخلي", fr: "Tell intérieur" },
  steppe: { ar: "الهضاب العليا", fr: "Hauts plateaux" },
  sahara: { ar: "الصحراء", fr: "Sahara" },
};

export const CROPS = {
  dates: { ar: "نخيل التمر", fr: "Palmier dattier" },
  tomato: { ar: "الطماطم", fr: "Tomate" },
  potato: { ar: "البطاطا", fr: "Pomme de terre" },
  onion: { ar: "البصل", fr: "Oignon" },
  pepper: { ar: "الفلفل", fr: "Poivron" },
  wheat: { ar: "القمح الصلب", fr: "Blé dur" },
  barley: { ar: "الشعير", fr: "Orge" },
  olive: { ar: "الزيتون", fr: "Olivier" },
  citrus: { ar: "الحمضيات", fr: "Agrumes" },
  grape: { ar: "العنب", fr: "Vigne" },
  apple: { ar: "التفاح", fr: "Pommier" },
  peach: { ar: "الخوخ", fr: "Pêcher" },
  apricot: { ar: "المشمش", fr: "Abricotier" },
  pomegranate: { ar: "الرمان", fr: "Grenadier" },
  fig: { ar: "التين", fr: "Figuier" },
  almond: { ar: "اللوز", fr: "Amandier" },
  watermelon: { ar: "الدلاع", fr: "Pastèque" },
  melon: { ar: "الشمّام", fr: "Melon" },
  carrot: { ar: "الجزر", fr: "Carotte" },
  garlic: { ar: "الثوم", fr: "Ail" },
  faba: { ar: "الفول", fr: "Féverole" },
  pea: { ar: "الجلبانة", fr: "Petit pois" },
  chickpea: { ar: "الحمص", fr: "Pois chiche" },
  lentil: { ar: "العدس", fr: "Lentille" },
  artichoke: { ar: "القرنون", fr: "Artichaut" },
  alfalfa: { ar: "الفصة", fr: "Luzerne" },
  alfa: { ar: "الحلفاء", fr: "Alfa" },
  sorghum: { ar: "الذرة الرفيعة", fr: "Sorgho" },
  henna: { ar: "الحناء", fr: "Henné" },
  groundnut: { ar: "الفول السوداني", fr: "Arachide" },
  rice: { ar: "الأرز", fr: "Riz" },
  sunflower: { ar: "عبّاد الشمس", fr: "Tournesol" },
} as const;

export type CropKey = keyof typeof CROPS;

export const SOILS = {
  sandy: { ar: "رملية", fr: "Sableux" },
  loamy: { ar: "طميية خصبة", fr: "Loameux" },
  clayey: { ar: "طينية ثقيلة", fr: "Argileux" },
  calcareous: { ar: "كلسية", fr: "Calcaire" },
  silty: { ar: "غرينية", fr: "Limoneux" },
  saline: { ar: "ملحية", fr: "Salé" },
  gravelly: { ar: "حصوية جبلية", fr: "Graveleux" },
} as const;

export type SoilKey = keyof typeof SOILS;

export interface ClimateBaseline {
  /** Mean daytime temperature for the reference season (°C). */
  tempC: number;
  /** Relative humidity (%). */
  humidity: number;
  /** Mean wind speed (km/h). */
  windKph: number;
  /** Long-term annual rainfall (mm). */
  rainMm: number;
}

export interface Wilaya {
  /** Official 2-digit code, e.g. "07". */
  code: string;
  nameAr: string;
  nameFr: string;
  region: WilayaRegion;
  altitudeM: number;
  climate: ClimateBaseline;
  soil: SoilKey;
  crops: CropKey[];
}

/** [code, nameAr, nameFr, region, altitude, tempC, humidity, wind, rain, soil, crops] */
type Row = [
  string,
  string,
  string,
  WilayaRegion,
  number,
  number,
  number,
  number,
  number,
  SoilKey,
  CropKey[],
];

const ROWS: Row[] = [
  ["01", "أدرار", "Adrar", "sahara", 260, 38, 18, 16, 25, "sandy", ["dates", "sorghum", "henna", "citrus", "groundnut"]],
  ["02", "الشلف", "Chlef", "coast", 110, 28, 65, 14, 450, "silty", ["citrus", "grape", "tomato", "watermelon", "olive"]],
  ["03", "الأغواط", "Laghouat", "steppe", 760, 29, 35, 18, 180, "gravelly", ["dates", "barley", "alfalfa", "apricot", "watermelon"]],
  ["04", "أم البواقي", "Oum El Bouaghi", "tell", 900, 24, 52, 13, 400, "calcareous", ["wheat", "barley", "olive", "apricot", "alfalfa", "potato"]],
  ["05", "باتنة", "Batna", "tell", 1040, 24, 50, 13, 350, "calcareous", ["wheat", "barley", "apricot", "potato", "apple", "olive"]],
  ["06", "بجاية", "Béjaïa", "coast", 30, 25, 74, 12, 800, "clayey", ["olive", "citrus", "fig", "tomato", "grape"]],
  ["07", "بسكرة", "Biskra", "sahara", 120, 34, 28, 14, 120, "sandy", ["dates", "tomato", "pepper", "potato", "apricot", "pomegranate"]],
  ["08", "بشار", "Béchar", "sahara", 780, 33, 25, 20, 80, "sandy", ["dates", "henna", "sorghum", "alfalfa", "watermelon"]],
  ["09", "البليدة", "Blida", "coast", 260, 27, 68, 12, 600, "silty", ["citrus", "tomato", "potato", "apricot", "olive", "peach"]],
  ["10", "البويرة", "Bouira", "tell", 550, 24, 60, 12, 650, "clayey", ["olive", "apple", "wheat", "potato", "fig", "tomato"]],
  ["11", "تمنراست", "Tamanrasset", "sahara", 1400, 31, 20, 18, 45, "gravelly", ["dates", "sorghum", "henna", "alfalfa", "groundnut"]],
  ["12", "تبسة", "Tébessa", "steppe", 900, 25, 45, 15, 300, "calcareous", ["wheat", "barley", "olive", "apricot", "alfalfa"]],
  ["13", "تلمسان", "Tlemcen", "coast", 810, 25, 62, 13, 450, "calcareous", ["olive", "grape", "citrus", "almond", "wheat", "artichoke"]],
  ["14", "تيارت", "Tiaret", "steppe", 1080, 25, 48, 16, 320, "clayey", ["wheat", "barley", "lentil", "chickpea", "alfalfa", "potato"]],
  ["15", "تيزي وزو", "Tizi Ouzou", "coast", 200, 25, 72, 12, 750, "clayey", ["olive", "fig", "tomato", "potato", "citrus"]],
  ["16", "الجزائر", "Alger", "coast", 25, 26, 72, 14, 600, "silty", ["tomato", "potato", "artichoke", "citrus", "olive", "carrot"]],
  ["17", "الجلفة", "Djelfa", "steppe", 1140, 25, 42, 18, 250, "gravelly", ["alfa", "barley", "wheat", "apricot", "lentil", "potato"]],
  ["18", "جيجل", "Jijel", "coast", 15, 25, 76, 13, 1000, "clayey", ["citrus", "tomato", "potato", "olive", "melon"]],
  ["19", "سطيف", "Sétif", "tell", 1100, 23, 55, 13, 450, "calcareous", ["wheat", "barley", "lentil", "chickpea", "potato", "pea"]],
  ["20", "سعيدة", "Saïda", "steppe", 870, 26, 48, 15, 350, "calcareous", ["wheat", "barley", "lentil", "olive", "potato"]],
  ["21", "سكيكدة", "Skikda", "coast", 20, 25, 73, 14, 700, "silty", ["citrus", "tomato", "potato", "olive", "fig"]],
  ["22", "سيدي بلعباس", "Sidi Bel Abbès", "tell", 470, 26, 58, 14, 400, "clayey", ["wheat", "barley", "olive", "grape", "almond", "citrus"]],
  ["23", "عنابة", "Annaba", "coast", 10, 25, 75, 13, 650, "silty", ["citrus", "tomato", "potato", "artichoke", "carrot"]],
  ["24", "قالمة", "Guelma", "tell", 300, 26, 60, 12, 600, "clayey", ["wheat", "tomato", "potato", "olive", "citrus", "rice"]],
  ["25", "قسنطينة", "Constantine", "tell", 640, 25, 58, 13, 500, "calcareous", ["wheat", "potato", "olive", "tomato", "apricot", "fig"]],
  ["26", "المدية", "Médéa", "tell", 920, 24, 58, 13, 550, "calcareous", ["apricot", "olive", "wheat", "potato", "apple", "grape"]],
  ["27", "مستغانم", "Mostaganem", "coast", 60, 27, 70, 15, 400, "silty", ["tomato", "potato", "citrus", "watermelon", "artichoke"]],
  ["28", "المسيلة", "M'Sila", "steppe", 470, 27, 45, 16, 250, "calcareous", ["wheat", "barley", "alfalfa", "olive", "apricot", "potato"]],
  ["29", "معسكر", "Mascara", "tell", 550, 27, 60, 14, 420, "calcareous", ["wheat", "olive", "grape", "citrus", "tomato", "lentil"]],
  ["30", "ورقلة", "Ouargla", "sahara", 130, 36, 24, 17, 45, "saline", ["dates", "potato", "watermelon", "alfalfa", "onion", "tomato"]],
  ["31", "وهران", "Oran", "coast", 90, 26, 68, 16, 400, "silty", ["citrus", "potato", "tomato", "artichoke", "watermelon", "olive"]],
  ["32", "البيض", "El Bayadh", "steppe", 1300, 24, 40, 19, 220, "gravelly", ["barley", "wheat", "alfa", "apricot", "alfalfa"]],
  ["33", "إليزي", "Illizi", "sahara", 570, 36, 18, 18, 25, "sandy", ["dates", "sorghum", "alfalfa", "henna"]],
  ["34", "برج بوعريريج", "Bordj Bou Arreridj", "tell", 900, 25, 56, 13, 400, "calcareous", ["wheat", "potato", "olive", "apricot", "pea"]],
  ["35", "بومرداس", "Boumerdès", "coast", 40, 26, 72, 13, 650, "silty", ["citrus", "tomato", "potato", "artichoke", "watermelon"]],
  ["36", "الطارف", "El Tarf", "coast", 20, 25, 76, 12, 900, "clayey", ["rice", "citrus", "tomato", "potato", "olive"]],
  ["37", "تندوف", "Tindouf", "sahara", 400, 34, 22, 21, 40, "sandy", ["dates", "alfalfa", "sorghum", "watermelon"]],
  ["38", "تيسمسيلت", "Tissemsilt", "steppe", 850, 25, 50, 15, 400, "calcareous", ["wheat", "barley", "olive", "lentil", "apricot"]],
  ["39", "الوادي", "El Oued", "sahara", 80, 36, 25, 16, 70, "saline", ["potato", "onion", "watermelon", "dates", "pepper", "groundnut"]],
  ["40", "خنشلة", "Khenchela", "tell", 1200, 23, 52, 13, 400, "gravelly", ["wheat", "barley", "apricot", "apple", "potato", "olive"]],
  ["41", "سوق أهراس", "Souk Ahras", "tell", 700, 24, 62, 13, 600, "clayey", ["wheat", "tomato", "potato", "olive", "chickpea", "apricot"]],
  ["42", "تيبازة", "Tipaza", "coast", 50, 26, 71, 14, 550, "silty", ["citrus", "tomato", "artichoke", "potato", "grape", "watermelon"]],
  ["43", "ميلة", "Mila", "tell", 500, 24, 58, 13, 500, "clayey", ["wheat", "tomato", "olive", "citrus", "potato", "apricot"]],
  ["44", "عين الدفلى", "Aïn Defla", "tell", 300, 27, 62, 14, 480, "silty", ["tomato", "citrus", "potato", "grape", "artichoke", "olive"]],
  ["45", "النعامة", "Naâma", "steppe", 1150, 25, 38, 19, 200, "gravelly", ["barley", "wheat", "dates", "alfa", "apricot"]],
  ["46", "عين تموشنت", "Aïn Témouchent", "coast", 200, 26, 67, 15, 380, "calcareous", ["grape", "citrus", "tomato", "potato", "watermelon", "olive"]],
  ["47", "غرداية", "Ghardaïa", "sahara", 460, 34, 28, 16, 90, "sandy", ["dates", "tomato", "potato", "onion", "pepper"]],
  ["48", "غليزان", "Relizane", "tell", 120, 28, 60, 14, 380, "silty", ["citrus", "tomato", "potato", "watermelon", "artichoke", "olive"]],
  ["49", "المغير", "El M'Ghair", "sahara", 60, 36, 24, 16, 60, "saline", ["dates", "potato", "watermelon", "onion", "pepper"]],
  ["50", "المنيعة", "El Menia", "sahara", 380, 34, 25, 17, 40, "sandy", ["dates", "potato", "sorghum", "alfalfa", "onion"]],
  ["51", "أولاد جلال", "Ouled Djellal", "sahara", 200, 34, 27, 15, 110, "sandy", ["dates", "tomato", "apricot", "pepper", "alfalfa", "potato"]],
  ["52", "برج باجي مختار", "Bordj Baji Mokhtar", "sahara", 280, 38, 15, 22, 20, "sandy", ["dates", "sorghum", "alfalfa"]],
  ["53", "بني عباس", "Béni Abbès", "sahara", 500, 35, 20, 19, 35, "sandy", ["dates", "sorghum", "henna", "alfalfa", "watermelon"]],
  ["54", "تيميمون", "Timimoun", "sahara", 300, 37, 19, 18, 22, "sandy", ["dates", "henna", "sorghum", "citrus", "groundnut"]],
  ["55", "تقرت", "Touggourt", "sahara", 90, 36, 25, 17, 50, "saline", ["dates", "potato", "onion", "watermelon", "pepper", "tomato"]],
  ["56", "جانت", "Djanet", "sahara", 1050, 33, 17, 20, 20, "gravelly", ["dates", "sorghum", "alfalfa"]],
  ["57", "عين صالح", "In Salah", "sahara", 270, 39, 16, 19, 15, "sandy", ["dates", "henna", "sorghum", "citrus", "alfalfa"]],
  ["58", "عين قزام", "In Guezzam", "sahara", 400, 39, 16, 20, 18, "sandy", ["dates", "sorghum", "alfalfa"]],
];

export const WILAYAS: Wilaya[] = ROWS.map(
  ([code, nameAr, nameFr, region, altitudeM, tempC, humidity, windKph, rainMm, soil, crops]) => ({
    code,
    nameAr,
    nameFr,
    region,
    altitudeM,
    climate: { tempC, humidity, windKph, rainMm },
    soil,
    crops,
  }),
);

export const WILAYA_BY_CODE: Record<string, Wilaya> = Object.fromEntries(
  WILAYAS.map((w) => [w.code, w]),
);

export const DEFAULT_WILAYA_CODE = "07"; // Biskra — a national agri-hub, first-run default.

export function getWilaya(code: string | null | undefined): Wilaya {
  return (code && WILAYA_BY_CODE[code]) || WILAYA_BY_CODE[DEFAULT_WILAYA_CODE];
}

export function wilayaName(w: Wilaya, lang: Lang): string {
  return lang === "ar" ? w.nameAr : w.nameFr;
}

/** Normalizes Arabic + French text so "Setif" finds "Sétif" and "بسكره" finds "بسكرة". */
export function normalizeQuery(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // latin diacritics
    .replace(/[\u064B-\u0652\u0670\u0640]/g, "") // arabic harakat + tatweel
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[ؤئء]/g, "ء")
    .replace(/[^a-z0-9\u0600-\u06FF]+/g, " ")
    .trim();
}

/** Search across code, Arabic name, French name and region. */
export function searchWilayas(query: string, lang: Lang = "ar"): Wilaya[] {
  const q = normalizeQuery(query);
  if (!q) return WILAYAS;
  const terms = q.split(" ").filter(Boolean);
  return WILAYAS.filter((w) => {
    const haystack = normalizeQuery(
      `${w.code} ${w.nameAr} ${w.nameFr} ${REGIONS[w.region].ar} ${REGIONS[w.region].fr}`,
    );
    return terms.every((term) => haystack.includes(term));
  }).sort((a, b) => {
    // Prefix matches on the active-language name float to the top.
    const an = normalizeQuery(lang === "ar" ? a.nameAr : a.nameFr);
    const bn = normalizeQuery(lang === "ar" ? b.nameAr : b.nameFr);
    const ap = an.startsWith(q) ? 0 : 1;
    const bp = bn.startsWith(q) ? 0 : 1;
    return ap - bp || an.localeCompare(bn);
  });
}
