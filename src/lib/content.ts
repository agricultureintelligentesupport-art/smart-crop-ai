export type Lang = "ar" | "fr";

export type SlideId = "scan" | "irrigation" | "satellite";

export interface SlideCopy {
  kicker: string;
  title: string;
  description: string;
}

export interface Copy {
  dir: "rtl" | "ltr";
  brand: string;
  brandTag: string;
  skip: string;
  next: string;
  swipeHint: string;
  createAccount: string;
  signIn: string;
  stepWord: string;
  languageAria: string;
  slides: SlideCopy[];
}

export const SLIDES: readonly SlideId[] = ["scan", "irrigation", "satellite"];

export const COPY: Record<Lang, Copy> = {
  ar: {
    dir: "rtl",
    brand: "محصولي الذكي",
    brandTag: "منصّة الزراعة الذكية",
    skip: "تخطي",
    next: "التالي",
    swipeHint: "اسحب لتصفّح الخطوات",
    createAccount: "إنشاء حساب",
    signIn: "تسجيل الدخول",
    stepWord: "خطوة",
    languageAria: "اختيار اللغة",
    slides: [
      {
        kicker: "تشخيص فوري",
        title: "تشخيص فوري للأمراض",
        description:
          "التقط صورة لورقة النبات واحصل على التشخيص والعلاج الدقيق بالذكاء الاصطناعي خلال ثوانٍ.",
      },
      {
        kicker: "ريّ موفّر",
        title: "سقي ذكي واقتصاد المياه",
        description:
          "احسب الاحتياج المائي اليومي لأرضك بناءً على بيانات الطقس المحلية لتوفير مياه السقي.",
      },
      {
        kicker: "استشعار عن بُعد",
        title: "مراقبة المزرعة بالأقمار",
        description:
          "تابع صحة التربة ونمو المحاصيل عبر الخرائط الحرارية للأقمار الصناعية بانتظام.",
      },
    ],
  },
  fr: {
    dir: "ltr",
    brand: "Smart Crop AI",
    brandTag: "Agriculture de précision",
    skip: "Passer",
    next: "Suivant",
    swipeHint: "Glissez pour parcourir les étapes",
    createAccount: "Créer un compte",
    signIn: "Se connecter",
    stepWord: "Étape",
    languageAria: "Choix de la langue",
    slides: [
      {
        kicker: "Diagnostic instantané",
        title: "Diagnostic IA des Maladies",
        description:
          "Photographiez une feuille de plante et obtenez en quelques secondes un diagnostic précis et le traitement recommandé par l'IA.",
      },
      {
        kicker: "Économie d'eau",
        title: "Irrigation Hydro-Intelligente",
        description:
          "Calculez les besoins en eau quotidiens de votre parcelle à partir des données météo locales pour économiser l'eau d'irrigation.",
      },
      {
        kicker: "Imagerie satellite",
        title: "Cartographie Satellite",
        description:
          "Suivez régulièrement la santé du sol et la croissance des cultures grâce aux cartes thermiques des satellites.",
      },
    ],
  },
};
