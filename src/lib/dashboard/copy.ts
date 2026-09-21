/**
 * Bilingual copy for the member dashboard. Same shape-first convention as
 * `lib/auth/copy.ts`: `AR` defines the contract.
 */

import type { Lang } from "@/lib/wilayas";
import type { DiagnosisKey } from "@/lib/agronomy";

export interface DiagnosisCopy {
  name: string;
  summary: string;
  steps: string[];
}

export interface DashboardCopy {
  header: {
    badgeMember: string;
    badgeGuest: string;
    navHome: string;
    signOut: string;
    langAr: string;
    langFr: string;
  };
  welcome: {
    member: string;
    caption: string;
  };
  personalize: {
    title: string;
    subtitle: string;
    wilaya: string;
    role: string;
    savedNote: string;
    edit: string;
    close: string;
    search: string;
    searchPlaceholder: string;
    noResults: string;
    roleOptions: { farmer: string; agronomist: string; investor: string };
  };
  weather: {
    title: string;
    subtitle: string;
    now: string;
    humidity: string;
    wind: string;
    rain: string;
    et0: string;
    hourLabel: string;
    hourUnit: string;
    rainChance: string;
    days: string;
    dayLabels: [string, string, string, string, string, string, string];
    adviceHeat: string;
    adviceIrrigate: string;
    adviceWind: string;
    adviceCalm: string;
    baselineNote: string;
  };
  irrigation: {
    title: string;
    subtitle: string;
    crop: string;
    area: string;
    areaUnit: string;
    soil: string;
    system: string;
    systems: { drip: string; sprinkler: string; furrow: string };
    perHectare: string;
    perDay: string;
    perWeek: string;
    saved: string;
    savedCaption: string;
    formulaNote: string;
  };
  scan: {
    title: string;
    subtitle: string;
    pick: string;
    pickHint: string;
    analyzing: string;
    result: string;
    confidence: string;
    severity: string;
    severityLabels: [string, string, string, string];
    treatment: string;
    retake: string;
    privacy: string;
    engineNote: string;
  };
  satellite: {
    title: string;
    subtitle: string;
    value: string;
    trend: string;
    window: string;
    stress: string;
    bands: { poor: string; fair: string; good: string; excellent: string };
    note: string;
  };
  tasks: {
    title: string;
    subtitle: string;
    irrigation: string;
    irrigationDetail: string;
    wind: string;
    windDetail: string;
    heat: string;
    heatDetail: string;
    scan: string;
    scanDetail: string;
    done: string;
    remaining: string;
  };
  advice: {
    title: string;
    subtitle: string;
    line1: string;
    line2: string;
    line3: string;
  };
  footer: {
    disclaimer: string;
    builtWith: string;
  };
  diagnoses: Record<DiagnosisKey, DiagnosisCopy>;
}

const AR: DashboardCopy = {
  header: {
    badgeMember: "حساب مُفعّل",
    badgeGuest: "حساب زائر",
    navHome: "الرئيسية",
    signOut: "تسجيل الخروج",
    langAr: "العربية",
    langFr: "Français",
  },
  welcome: {
    member: "مرحباً، {name}",
    caption: "لوحة مرجعية مبنية على بيانات ولاية {wilaya} لموسم {month}",
  },
  personalize: {
    title: "تخصيص اللوحة",
    subtitle: "غيّر الولاية أو الصفة لتحديث الطقس والمحاصيل والتنبيهات فوراً.",
    wilaya: "الولاية",
    role: "الصفة",
    savedNote: "حُفظت اختياراتك على هذا الجهاز.",
    edit: "تعديل",
    close: "إغلاق",
    search: "بحث",
    searchPlaceholder: "اسم الولاية أو رقمها…",
    noResults: "لا نتائج",
    roleOptions: { farmer: "فلاح", agronomist: "مهندس زراعي", investor: "مستثمر" },
  },
  weather: {
    title: "الطقس والاحتياج المائي",
    subtitle: "بيانات مرجعية لموسم الخريف في {wilaya}.",
    now: "الآن",
    humidity: "الرطوبة",
    wind: "الرياح",
    rain: "أمطار سنوية",
    et0: "تبخر مرجعي",
    hourLabel: "الساعات القادمة",
    hourUnit: "°C",
    rainChance: "احتمال مطر {n}%",
    days: "الأيام السبعة القادمة",
    dayLabels: ["أحد", "إثنين", "ثلاثاء", "أربعاء", "خميس", "جمعة", "سبت"],
    adviceHeat: "موجة حرارة: اسقِ قبل الساعة الثامنة صباحاً وتجنّب الرشّ الظهيرة.",
    adviceIrrigate: "التبخر معتدل: التزم بجدول السقي المعتاد اليوم.",
    adviceWind: "رياح قوية نسبياً: نزّل ضغط الرشّ وارشّ في الصباح الباكر.",
    adviceCalm: "ظروف مناسبة للعمل الميداني والرشّ اليوم.",
    baselineNote: "قيم إحصائية طويلة المدى، تُحدَّث عند ربط خدمة الطقس الحيّة.",
  },
  irrigation: {
    title: "حاسبة السقي",
    subtitle: "قدّر كمية الماء اللازمة لقطعتك حسب المحصول والنظام.",
    crop: "المحصول",
    area: "المساحة بالسقي",
    areaUnit: "هكتار",
    soil: "نوع التربة",
    system: "نظام السقي",
    systems: { drip: "بالتنقيط", sprinkler: "بالرشّ", furrow: "غمر/أخاديد" },
    perHectare: "لكل هكتار يومياً",
    perDay: "لكل قطعة يومياً",
    perWeek: "أسبوعياً",
    saved: "ماء موفّر يومياً",
    savedCaption: "مقارنة بالسقي بالغمر على نفس المساحة",
    formulaNote: "الحساب: تبخر مرجعي × معامل المحصول × عامل التربة ÷ كفاءة النظام.",
  },
  scan: {
    title: "تشخيص صحة النبات",
    subtitle: "التقط صورة لورقة أو انسخها من المعرض للحصول على قراءة وتوصية.",
    pick: "اختر صورة الورقة",
    pickHint: "JPEG أو PNG، تبقى الصورة على جهازك",
    analyzing: "جارٍ تحليل الصورة…",
    result: "النتيجة المبدئية",
    confidence: "درجة الثقة",
    severity: "شدة الإصابة",
    severityLabels: ["سليمة", "خفيفة", "متوسطة", "مرتفعة"],
    treatment: "التوصية الميدانية",
    retake: "صورة جديدة",
    privacy: "الصورة تُعالج محلياً في هذا الوضع التجريبي ولا تُرفع إلينا.",
    engineNote: "المحرك الحالي تجريبي على الجهاز؛ سيُستبدل بنموذج التدريب عند ربط الخادم.",
  },
  satellite: {
    title: "مؤشر الغطاء النباتي",
    subtitle: "قراءة تقديرية لكثافة الغطاء الأخضر في قطعتك.",
    value: "المؤشر NDVI",
    trend: "التغير خلال 8 أسابيع",
    window: "النافذة",
    stress: "نسبة الإجهاد التقديرية",
    bands: { poor: "ضعيف", fair: "متوسط", good: "جيد", excellent: "ممتاز" },
    note: "يحاكي هذا الرسم طبقة الأقمار الصناعية؛ المصدر الحقيقي يُربط عبر Sentinel-2.",
  },
  tasks: {
    title: "مهام اليوم",
    subtitle: "قائمة مشتقة من الطقس والمحاصيل المختارة.",
    irrigation: "سقاية القطعة",
    irrigationDetail: "التزم بـ {value} م³ اليوم حسب الحساب.",
    wind: "فحص شبكة السقي",
    windDetail: "رياح {value} كم/س، تحقق من النقاطات المغطاة بالرمل.",
    heat: "حماية النباتات من الحرارة",
    heatDetail: "الحرارة {value}°، رشّ شبكة التظليل إن وُجدت.",
    scan: "مسح ورقة أسبوعي",
    scanDetail: "صوّر 5 أوراق من نقاط مختلفة في القطعة.",
    done: "منجزة",
    remaining: "باقية {n}",
  },
  advice: {
    title: "قراءة سريعة",
    subtitle: "خلاصة تعتمد على الطقس والمحصول المختار.",
    line1: "سقِ بمعدل {mm} مم اليوم على {area} هكتار.",
    line2: "أفضل نافذة للسقي: من {from} إلى {to}.",
    line3: "راقب {crop}: الظروف مناسبة لإنتشار {risk}.",
  },
  footer: {
    disclaimer: "كل الأرقام تقديرية لدعم القرار ولا تعوّض القياس الميداني أو تشخيص مهندس زراعي.",
    builtWith: "محصولي الذكي · لوحة الزراعة الدقيقة",
  },
  diagnoses: {
    healthy: {
      name: "ورقة سليمة",
      summary: "لا تظهر علامات مرضية واضحة، النمو في وضع جيد.",
      steps: ["استمر في برنامج التسميد الحالي", "أعد الفحص كل أسبوع", "راقب الرطوبة حول الجذور"],
    },
    early_blight: {
      name: "لفحة مبكرة",
      summary: "بقع بنية دائرية مع هالة صفراء، شائعة في الطماطم والبطاطا.",
      steps: ["أزل الأوراق المصابة وحرقها", "رشّ نحاسياً أو مبيداً فطرياً معتمداً", "قلّل الرطوبة وأبعِد الرشّ إلى الصباح"],
    },
    powdery_mildew: {
      name: "بياض دقيقي",
      summary: "طبقة بيضاء دقيقية على سطح الورقة، تتوسع في الجو الدافئ الجاف نهاراً.",
      steps: ["حسّن التهوية وقصّ الأوراق الزائدة", "رشّ الكبريت المعلّق مساءً", "تجنّب الريّ بالرشّ العلوي"],
    },
    leaf_rust: {
      name: "صدأ الأوراق",
      summary: "بثور صدئية على الأوراق، تنتشر سريعاً في الحبوب مع الندى الصباحي.",
      steps: ["أوقف التسميد الآزوتي مؤقتاً", "رشّ مبيداً فطرياً موجهاً للصدأ", "باعد بين مواعيد السقي بالرشّ"],
    },
    nitrogen_gap: {
      name: "نقص آزوت",
      summary: "اصفرار منتظم للأوراق الأقدم يشير إلى نقص الآزوت في التربة.",
      steps: ["أضف 20 إلى 30 كغ آزوت للهكتار", "ادمجها مع سقي خفيف", "أعد الفحص بعد 5 أيام"],
    },
    water_stress: {
      name: "إجهاد مائي",
      summary: "الأوراق مطوية والأطراف جافة، الطلب المائي يتجاوز الكمية المسقية.",
      steps: ["أضف حصة سقي تعويضية المساء", "تأكد من ضغط الشبكة ونظافة النقاطات", "غطّ التربة بالمالش لتقليل التبخر"],
    },
  },
};

const FR: DashboardCopy = {
  header: {
    badgeMember: "Compte actif",
    badgeGuest: "Compte invité",
    navHome: "Accueil",
    signOut: "Se déconnecter",
    langAr: "العربية",
    langFr: "Français",
  },
  welcome: {
    member: "Bienvenue, {name}",
    caption: "Tableau de référence basé sur la wilaya de {wilaya} pour la saison {month}",
  },
  personalize: {
    title: "Personnaliser",
    subtitle: "Changez de wilaya ou de profil : météo, cultures et alertes suivent immédiatement.",
    wilaya: "Wilaya",
    role: "Profil",
    savedNote: "Vos choix sont enregistrés sur cet appareil.",
    edit: "Modifier",
    close: "Fermer",
    search: "Recherche",
    searchPlaceholder: "Nom ou numéro de wilaya…",
    noResults: "Aucun résultat",
    roleOptions: { farmer: "Agriculteur", agronomist: "Agronome", investor: "Investisseur" },
  },
  weather: {
    title: "Météo et besoin en eau",
    subtitle: "Données de référence d'automne pour {wilaya}.",
    now: "Maintenant",
    humidity: "Humidité",
    wind: "Vent",
    rain: "Pluie annuelle",
    et0: "Évapotranspiration",
    hourLabel: "Prochaines heures",
    hourUnit: "°C",
    rainChance: "Risque de pluie {n} %",
    days: "Sept jours à venir",
    dayLabels: ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"],
    adviceHeat: "Vague de chaleur : irriguez avant 8 h et évitez l'aspersion à midi.",
    adviceIrrigate: "Évaporation modérée : gardez le planning d'irrigation du jour.",
    adviceWind: "Vent soutenu : baissez la pression d'aspersion et arrosez tôt le matin.",
    adviceCalm: "Conditions favorables au travail de parcelle et au traitement aujourd'hui.",
    baselineNote: "Valeurs statistiques long terme, remplacées dès que le service météo est connecté.",
  },
  irrigation: {
    title: "Calculateur d'irrigation",
    subtitle: "Estimez le volume d'eau de votre parcelle selon la culture et le système.",
    crop: "Culture",
    area: "Surface irriguée",
    areaUnit: "hectares",
    soil: "Type de sol",
    system: "Système d'irrigation",
    systems: { drip: "Goutte à goutte", sprinkler: "Aspersion", furrow: "Raies / gravitaire" },
    perHectare: "Par hectare et par jour",
    perDay: "Pour la parcelle, par jour",
    perWeek: "Par semaine",
    saved: "Eau économisée par jour",
    savedCaption: "Comparé au gravitaire sur la même surface",
    formulaNote: "Calcul : ET0 × coefficient cultural × facteur sol ÷ efficacité du système.",
  },
  scan: {
    title: "Diagnostic de la feuille",
    subtitle: "Photographiez une feuille ou choisissez une image pour une lecture et une recommandation.",
    pick: "Choisir une photo de feuille",
    pickHint: "JPEG ou PNG, l'image reste sur votre appareil",
    analyzing: "Analyse de l'image…",
    result: "Résultat préliminaire",
    confidence: "Confiance",
    severity: "Sévérité",
    severityLabels: ["Saine", "Faible", "Moyenne", "Élevée"],
    treatment: "Recommandation terrain",
    retake: "Nouvelle photo",
    privacy: "En mode démo, l'image est traitée localement et n'est jamais envoyée.",
    engineNote: "Le moteur actuel tourne sur l'appareil ; il sera remplacé par le modèle entraîné.",
  },
  satellite: {
    title: "Indice de végétation",
    subtitle: "Lecture estimée de la densité du couvert vert de votre parcelle.",
    value: "Indice NDVI",
    trend: "Évolution sur 8 semaines",
    window: "Fenêtre",
    stress: "Part de stress estimée",
    bands: { poor: "Faible", fair: "Moyen", good: "Bon", excellent: "Excellent" },
    note: "Ce graphique simule la couche satellite ; la source réelle arrive via Sentinel-2.",
  },
  tasks: {
    title: "Tâches du jour",
    subtitle: "Liste dérivée de la météo et des cultures sélectionnées.",
    irrigation: "Irriguer la parcelle",
    irrigationDetail: "Respectez {value} m³ aujourd'hui selon le calcul.",
    wind: "Vérifier le réseau d'irrigation",
    windDetail: "Vent {value} km/h, contrôlez les goutteurs ensablés.",
    heat: "Protéger les plants de la chaleur",
    heatDetail: "Température {value}°, activez l'ombrage si disponible.",
    scan: "Scan hebdomadaire des feuilles",
    scanDetail: "Photographiez 5 feuilles à des points différents.",
    done: "Terminées",
    remaining: "{n} restantes",
  },
  advice: {
    title: "Lecture rapide",
    subtitle: "Synthèse basée sur la météo et la culture choisie.",
    line1: "Irriguez {mm} mm aujourd'hui sur {area} hectares.",
    line2: "Meilleure fenêtre d'irrigation : de {from} à {to}.",
    line3: "Surveillez {crop} : conditions favorables au développement de {risk}.",
  },
  footer: {
    disclaimer: "Toutes les valeurs sont des estimations d'aide à la décision, sans remplacer la mesure terrain ni l'avis d'un agronome.",
    builtWith: "Smart Crop AI · tableau d'agriculture de précision",
  },
  diagnoses: {
    healthy: {
      name: "Feuille saine",
      summary: "Aucun signe pathologique net, la croissance est bonne.",
      steps: ["Poursuivez le programme de fertilisation", "Refaites un contrôle chaque semaine", "Surveillez l'humidité autour des racines"],
    },
    early_blight: {
      name: "Alternariose (brûlure précoce)",
      summary: "Taches brunes arrondies avec halo jaune, fréquentes sur tomate et pomme de terre.",
      steps: ["Retirez et brûlez les feuilles atteintes", "Appliquez du cuivre ou un fongicide homologué", "Réduisez l'humidité et aspersez le matin"],
    },
    powdery_mildew: {
      name: "Oïdium",
      summary: "Voile blanc poudreux sur la feuille, qui s'étend par temps doux et sec.",
      steps: ["Améliorez l'aération et taillez l'excès de feuillage", "Appliquez du soufre mouillable le soir", "Évitez l'irrigation par aspersion foliaire"],
    },
    leaf_rust: {
      name: "Rouille des feuilles",
      summary: "Pustules couleur rouille, propagation rapide sur céréales avec la rosée.",
      steps: ["Stoppez temporairement l'azote", "Traitez avec un fongicide anti-rouille", "Espacez les irrigations par aspersion"],
    },
    nitrogen_gap: {
      name: "Carence azotée",
      summary: "Jaunissement régulier des feuilles anciennes, typique d'un manque d'azote.",
      steps: ["Apportez 20 à 30 kg d'azote par hectare", "Associez à une irrigation légère", "Contrôlez à nouveau après 5 jours"],
    },
    water_stress: {
      name: "Stress hydrique",
      summary: "Feuilles enroulées et bords secs : le besoin dépasse l'eau apportée.",
      steps: ["Ajoutez une irrigation de rattrapage le soir", "Vérifiez la pression et la propreté des goutteurs", "Paillez le sol pour limiter l'évaporation"],
    },
  },
};

export const DASHBOARD: Record<Lang, DashboardCopy> = { ar: AR, fr: FR };
