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
  /** Native app-shell vocabulary: hero decision card, quick actions, sections. */
  hero: {
    eyebrow: string;
    needLabel: string;
    perHa: string;
    window: string;
    /** Time range of the day's best irrigation window (LTR-pinned in the UI). */
    windowValue: string;
  };
  /** Irrigation-window detail sheet: why this window + volume (real inputs only). */
  windowDetail: {
    /** Accessible label for the window tile's expand control. */
    ariaOpen: string;
    title: string;
    subtitle: string;
    windowLabel: string;
    volumeLabel: string;
    perHaLabel: string;
    whyTitle: string;
    windowFixed: string;
    rulesNote: string;
    ruleHeatTitle: string;
    ruleHeatText: string;
    ruleWindTitle: string;
    ruleWindText: string;
    ruleEt0Title: string;
    ruleEt0Text: string;
    ruleCalmTitle: string;
    ruleCalmText: string;
    activeRule: string;
    dataTitle: string;
    /** Reference-mode note (data = wilaya reference series). */
    dataNote: string;
    /** Live-mode note (data = Open-Meteo forecast). */
    dataNoteLive: string;
    hoursTempTitle: string;
    hoursTempNote: string;
    weekTempTitle: string;
    weekTempNote: string;
    /** Live-mode note for the 7-day range chart. */
    weekTempNoteLive: string;
    hoursRainTitle: string;
    hoursRainNote: string;
    /** Shared note for the four hourly charts in live mode. */
    hoursLiveNote: string;
    humidityChartTitle: string;
    windChartTitle: string;
    singleTitle: string;
    singleNote: string;
    singleTitleLive: string;
    singleNoteLive: string;
    tempRef: string;
    breakdownTitle: string;
    stepEt0Label: string;
    stepEt0Formula: string;
    stepEt0Note: string;
    stepNetLabel: string;
    stepNetFormula: string;
    stepNetNote: string;
    stepGrossLabel: string;
    stepGrossFormula: string;
    stepGrossNote: string;
    stepVolumeLabel: string;
    stepVolumeFormula: string;
    stepParcelFormula: string;
    stepVolumeNote: string;
    /** Reference-mode source note (live fetch failed/unavailable). */
    sourceNote: string;
    /** Live-mode source note (Open-Meteo data). */
    sourceNoteLive: string;
  };
  quick: {
    title: string;
    scan: string;
    irrigation: string;
    tasks: string;
    /** Accessible label for a quick action: "انتقل إلى {target}". */
    goTo: string;
  };
  sections: {
    weather: string;
    field: string;
  };
  account: {
    title: string;
    subtitle: string;
    personalization: string;
    intro: string;
    introHint: string;
    about: string;
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
    /** Shown only when the live fetch failed — reference values are displayed. */
    baselineNote: string;
    /** Shown when live Open-Meteo data is displayed ({time} = last update). */
    liveNote: string;
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
  hero: {
    eyebrow: "قرار اليوم",
    needLabel: "حاجة القطعة اليوم",
    perHa: "لكل هكتار",
    window: "نافذة السقي",
    windowValue: "05:30 — 08:30",
  },
  windowDetail: {
    ariaOpen: "لماذا هذه النافذة والكمية؟",
    title: "لماذا هذه النافذة والكمية؟",
    subtitle: "شرح مبني على نفس بيانات الولاية ومعادلات اللوحة — بلا أرقام إضافية.",
    windowLabel: "النافذة المقترحة",
    volumeLabel: "حاجة القطعة اليوم",
    perHaLabel: "لكل هكتار",
    whyTitle: "لماذا النافذة الصباحية؟",
    windowFixed:
      "في الإصدار الحالي، النافذة مقترحة صباحية ثابتة ({window}) قبل ذروة التبخر. لا توجد بعد معادلة تحسبها من بيانات بالساعة، لكن قواعد النصيحة أدناه — بنفس أرقام اللوحة — تفسّر تفضيل الصباح.",
    rulesNote: "قواعد بطاقة الطقس تُطبَّق بالترتيب: الحرارة ثم الرياح ثم التبخر.",
    ruleHeatTitle: "حرارة 33° فأكثر",
    ruleHeatText: "الحرارة المرجعية اليوم {temp}° → السقي قبل الثامنة صباحاً وتجنّب الرشّ ظهراً.",
    ruleWindTitle: "رياح 20 كم/س فأكثر",
    ruleWindText: "الرياح المرجعية اليوم {wind} كم/س → إنزال ضغط الرشّ والرشّ صباحاً باكراً.",
    ruleEt0Title: "تبخر 5 مم/يوم فأكثر",
    ruleEt0Text: "التبخر المرجعي اليوم {et0} مم/يوم → التزم بجدول السقي المعتاد.",
    ruleCalmTitle: "ظروف معتدلة",
    ruleCalmText: "لا حرارة مرتفعة ولا رياح قوية ولا تبخر عالٍ → ظروف مناسبة للسقي اليوم.",
    activeRule: "القاعدة النشطة اليوم",
    dataTitle: "المدخلات الفعلية للحساب",
    dataNote: "نفس السلاسل والقيم المرجعية التي تعرضها بطاقة الطقس لولاية {wilaya}.",
    dataNoteLive: "نفس القراءات الحيّة التي تعرضها بطاقة الطقس لولاية {wilaya}، من Open-Meteo.",
    hoursTempTitle: "درجة الحرارة — ساعات اليوم",
    hoursTempNote: "6 قراءات مرجعية من 06:00 إلى 21:00.",
    weekTempTitle: "المدى اليومي — 7 أيام",
    weekTempNote: "أدنى وأعلى درجة لكل يوم من السلسلة الأسبوعية المرجعية.",
    weekTempNoteLive: "أدنى وأعلى درجة متوقعة لكل يوم من التوقع الحيّ (7 أيام).",
    hoursRainTitle: "احتمال المطر — ساعات اليوم",
    hoursRainNote: "نسبة مرجعية لكل قراءة من قراءات الساعات.",
    hoursLiveNote: "6 قراءات ساعتية تالية من التوقع الحيّ (Open-Meteo).",
    humidityChartTitle: "الرطوبة — ساعات اليوم",
    windChartTitle: "الرياح — ساعات اليوم",
    singleTitle: "قيم مفردة — بلا سلسلة زمنية",
    singleNote:
      "المصدر الحالي يوفر الرطوبة والرياح كقيمة مرجعية واحدة للولاية فقط. لا توجد لهما قراءات بساعة أو تاريخية، لذلك لا نرسم لهما منحنيات.",
    singleTitleLive: "قياسات اللحظة الحالية",
    singleNoteLive:
      "قراءات اللحظة عند آخر تحديث من المصدر الحيّ؛ «أمطار سنوية» تبقى قيمة مناخية مرجعية طويلة المدى.",
    tempRef: "الحرارة المرجعية",
    breakdownTitle: "كيف حُسبت كمية اليوم",
    stepEt0Label: "التبخر المرجعي ET₀",
    stepEt0Formula: "0.155 × {temp}° × {damp} × {windFactor} = {raw} مم/يوم",
    stepEt0Note:
      "معامل الرطوبة {damp} ومعامل الرياح {windFactor} محسوبان من بيانات الولاية. يُقيَّد الناتج بين 1.4 و9.5 مم/يوم → النتيجة {et0} مم/يوم.",
    stepNetLabel: "الاحتياج الصافي للمحصول",
    stepNetFormula: "{et0} مم × {kc} (معامل {crop}) × {soilFactor} (تربة {soil}) = {net} مم/يوم",
    stepNetNote: "كمية الماء التي يحتاجها المحصول يومياً قبل خسائر نظام السقي.",
    stepGrossLabel: "الحجم الإجمالي حسب نظام السقي",
    stepGrossFormula: "{net} مم ÷ {efficiency} (كفاءة {system}) = {gross} مم/يوم",
    stepGrossNote: "كفاءة نظام {system} هي {effPct}%، فترفع الكمية الصافية لتغطية الخسائر.",
    stepVolumeLabel: "تحويل الملليمتر إلى حجم",
    stepVolumeFormula: "{gross} مم × 10 000 لتر/هكتار/مم = {litres} لتر/هكتار",
    stepParcelFormula: "{gross} مم × {area} هكتار × 10 م³/هكتار/مم = {daily} م³/يوم",
    stepVolumeNote: "الأسبوع: {weekly} م³. (1 مم فوق هكتار = 10 م³ = 10 000 لتر.)",
    sourceNote:
      "المدخلات: قيم مناخية مرجعية طويلة المدى للولاية محفوظة في التطبيق (تعذّر الوصول إلى المصدر الحيّ الآن)، ومعاملات ثابتة للمحصول والتربة والنظام.",
    sourceNoteLive:
      "المدخلات: قراءات حيّة من Open-Meteo (حرارة، رطوبة، رياح، احتمال مطر) محدّثة كل ساعة، ومعاملات ثابتة للمحصول والتربة والنظام. عند تعذّر المصدر تُعرض القيم المرجعية تلقائياً.",
  },
  quick: {
    title: "وصول سريع",
    scan: "تشخيص ورقة",
    irrigation: "حاسبة السقي",
    tasks: "مهام اليوم",
    goTo: "انتقل إلى {target}",
  },
  sections: {
    weather: "الطقس والسقي",
    field: "صحة النبات",
  },
  account: {
    title: "حسابي",
    subtitle: "خصّص الولاية والصفة؛ تتحدّث كل أرقام اللوحة فوراً.",
    personalization: "التخصيص",
    intro: "الشاشة التعريفية",
    introHint: "أعد مشاهدة الجولة التعريفية بميزات التطبيق.",
    about: "حول التطبيق",
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
    baselineNote: "تعذّر الوصول إلى الطقس الحيّ — تُعرض القيم المرجعية طويلة المدى للولاية.",
    liveNote: "بيانات حيّة من Open-Meteo · آخر تحديث {time} · تتحدّث كل ساعة.",
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
  hero: {
    eyebrow: "Décision du jour",
    needLabel: "Besoin de la parcelle",
    perHa: "Par hectare",
    window: "Fenêtre d'irrigation",
    windowValue: "05:30 — 08:30",
  },
  windowDetail: {
    ariaOpen: "Pourquoi cette fenêtre et ce volume ?",
    title: "Pourquoi cette fenêtre et ce volume ?",
    subtitle: "Explication basée sur les mêmes données de wilaya et les mêmes formules du tableau — aucun chiffre inventé.",
    windowLabel: "Fenêtre proposée",
    volumeLabel: "Besoin de la parcelle",
    perHaLabel: "Par hectare",
    whyTitle: "Pourquoi la fenêtre du matin ?",
    windowFixed:
      "Dans la version actuelle, la fenêtre est une fenêtre matinale fixe ({window}) avant le pic d'évaporation. Aucune formule ne la calcule encore à partir de données horaires, mais les règles de conseil ci-dessous — avec les mêmes chiffres du tableau — expliquent le choix du matin.",
    rulesNote: "Les règles de la carte météo s'appliquent dans l'ordre : chaleur, puis vent, puis évapotranspiration.",
    ruleHeatTitle: "Chaleur ≥ 33 °",
    ruleHeatText: "Température de référence aujourd'hui {temp}° → irriguez avant 8 h et évitez l'aspersion à midi.",
    ruleWindTitle: "Vent ≥ 20 km/h",
    ruleWindText: "Vent de référence aujourd'hui {wind} km/h → baissez la pression d'aspersion et arrosez tôt le matin.",
    ruleEt0Title: "Évapotranspiration ≥ 5 mm/jour",
    ruleEt0Text: "Évapotranspiration de référence aujourd'hui {et0} mm/jour → gardez le planning d'irrigation du jour.",
    ruleCalmTitle: "Conditions modérées",
    ruleCalmText: "Ni forte chaleur, ni vent fort, ni forte évaporation → conditions favorables à l'irrigation aujourd'hui.",
    activeRule: "Règle active aujourd'hui",
    dataTitle: "Données réellement utilisées",
    dataNote: "Les mêmes séries et valeurs de référence que la carte météo pour la wilaya {wilaya}.",
    dataNoteLive: "Les mêmes relevés en direct que la carte météo pour la wilaya {wilaya}, via Open-Meteo.",
    hoursTempTitle: "Température — heures de la journée",
    hoursTempNote: "6 lectures de référence, de 06:00 à 21:00.",
    weekTempTitle: "Amplitude quotidienne — 7 jours",
    weekTempNote: "Minimum et maximum de chaque jour de la série hebdomadaire de référence.",
    weekTempNoteLive: "Minimum et maximum prévus pour chacun des 7 prochains jours (en direct).",
    hoursRainTitle: "Risque de pluie — heures de la journée",
    hoursRainNote: "Pourcentage de référence pour chaque lecture horaire.",
    hoursLiveNote: "6 prochaines heures issues des prévisions en direct (Open-Meteo).",
    humidityChartTitle: "Humidité — heures de la journée",
    windChartTitle: "Vent — heures de la journée",
    singleTitle: "Valeurs uniques — sans série temporelle",
    singleNote:
      "La source actuelle ne fournit l'humidité et le vent qu'en valeur de référence unique par wilaya. Aucune lecture horaire ou historique n'existe pour l'instant ; nous ne dessinons donc pas de courbes pour elles.",
    singleTitleLive: "Relevés de l'instant",
    singleNoteLive:
      "Relevés de l'instant au dernier MAJ de la source en direct ; «pluie annuelle» reste une valeur climatique de référence.",
    tempRef: "Température de référence",
    breakdownTitle: "Comment le volume du jour est calculé",
    stepEt0Label: "Évapotranspiration de référence ET₀",
    stepEt0Formula: "0.155 × {temp}° × {damp} × {windFactor} = {raw} mm/jour",
    stepEt0Note:
      "Facteur d'humidité {damp} et facteur de vent {windFactor}, calculés sur les données de la wilaya. Le résultat est borné entre 1,4 et 9,5 mm/jour → {et0} mm/jour.",
    stepNetLabel: "Besoin net de la culture",
    stepNetFormula: "{et0} mm × {kc} (coefficient {crop}) × {soilFactor} (sol {soil}) = {net} mm/jour",
    stepNetNote: "L'eau dont la culture a besoin chaque jour, avant les pertes du système d'irrigation.",
    stepGrossLabel: "Volume brut selon le système",
    stepGrossFormula: "{net} mm ÷ {efficiency} (rendement {system}) = {gross} mm/jour",
    stepGrossNote: "Le rendement du système {system} est de {effPct} % ; le volume net est donc majoré pour couvrir les pertes.",
    stepVolumeLabel: "Conversion en volume",
    stepVolumeFormula: "{gross} mm × 10 000 L/ha/mm = {litres} L/ha",
    stepParcelFormula: "{gross} mm × {area} ha × 10 m³/ha/mm = {daily} m³/jour",
    stepVolumeNote: "Par semaine : {weekly} m³. (1 mm sur un hectare = 10 m³ = 10 000 L.)",
    sourceNote:
      "Données d'entrée : valeurs climatiques de référence à long terme de la wilaya, conservées dans l'application (source en direct indisponible pour l'instant), et coefficients fixes pour la culture, le sol et le système.",
    sourceNoteLive:
      "Données d'entrée : relevés en direct Open-Meteo (température, humidité, vent, risque de pluie), actualisés chaque heure, et coefficients fixes culture/sol/système. En cas d'indisponibilité, les valeurs de référence s'affichent automatiquement.",
  },
  quick: {
    title: "Accès rapide",
    scan: "Scanner une feuille",
    irrigation: "Calculateur d'irrigation",
    tasks: "Tâches du jour",
    goTo: "Aller à {target}",
  },
  sections: {
    weather: "Météo et eau",
    field: "Santé des cultures",
  },
  account: {
    title: "Mon profil",
    subtitle: "Choisissez wilaya et profil : tous les chiffres suivent aussitôt.",
    personalization: "Personnalisation",
    intro: "Écran de présentation",
    introHint: "Revoir la visite guidée des fonctionnalités.",
    about: "À propos",
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
    baselineNote: "Service météo live indisponible — valeurs de référence long terme affichées.",
    liveNote: "Données en direct Open-Meteo · MAJ {time} · actualisées chaque heure.",
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
