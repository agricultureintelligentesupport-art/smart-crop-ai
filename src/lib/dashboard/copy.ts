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
    /** Accessible label of the per-hectare pill (opens the calculation flow). */
    perHaOpen: string;
    /** Short trailing hint inside the per-hectare pill. */
    perHaCta: string;
  };
  /**
   * Per-hectare calculation flow: the same numbers the decision card shows,
   * unrolled as a step-by-step diagram with interactive factors.
   */
  flow: {
    title: string;
    /** `{crop}` `{wilaya}` `{system}` */
    subtitle: string;
    /** How to use the interactive factors. */
    hint: string;
    /** `{n}` */
    stepLabel: string;
    /** Row label for a step's produced value. */
    resultTag: string;
    /** Heading of the clickable-factor block. */
    factorsTag: string;
    climateTitle: string;
    climateNote: string;
    factorTemp: string;
    /** `{temp}` `{base}` */
    factorTempEffect: string;
    factorHumidity: string;
    /** `{humidity}` `{damp}` `{pct}` */
    factorHumidityEffect: string;
    factorWind: string;
    /** `{wind}` `{boost}` `{pct}` */
    factorWindEffect: string;
    cropTitle: string;
    cropNote: string;
    /** `{crop}` `{kc}` */
    factorKc: string;
    /** `{kc}` `{crop}` */
    factorKcEffect: string;
    factorSoil: string;
    /** `{soil}` `{soilFactor}` `{pct}` */
    factorSoilEffect: string;
    efficiencyTitle: string;
    efficiencyNote: string;
    /** `{efficiency}` */
    factorEfficiency: string;
    /** `{efficiency}` `{pct}` */
    factorEfficiencyEffect: string;
    hectareTitle: string;
    hectareNote: string;
    totalTitle: string;
    /** `{area}` */
    totalNote: string;
    /** Why the mm values carry two decimals (the chain stays exact). */
    precisionNote: string;
    /** `{litres}` `{daily}` — the promise that nothing diverges from the card. */
    syncNote: string;
  };
  /**
   * Field heatmap: the parcel split into zones, with three switchable layers
   * and a tap-to-inspect reading per zone. Values are model estimates centred
   * on the same daily average as the decision card.
   */
  heatmap: {
    title: string;
    /** `{area}` `{zones}` */
    subtitle: string;
    /** Accessible label of the layer switcher. */
    layersAria: string;
    layers: { thermal: string; moisture: string; transpiration: string };
    /** Zone letters, in reading order (up to 24 zones). */
    zoneIds: string[];
    /** `{id}` */
    zoneLabel: string;
    /** Accessible label of one zone cell: `{zone}` `{value}` `{unit}` `{status}`. */
    cellAria: string;
    units: { thermal: string; moisture: string; transpiration: string };
    status: {
      moisture: { wet: string; balanced: string; mildDry: string; dry: string };
      thermal: { low: string; moderate: string; high: string; severe: string };
      transpiration: { low: string; moderate: string; good: string; high: string };
    };
    /** Per-layer inspection sentence: `{value}` `{delta}`. */
    layerNote: { thermal: string; moisture: string; transpiration: string };
    /** `{pct}` */
    deltaAbove: string;
    /** `{pct}` */
    deltaBelow: string;
    deltaEven: string;
    /** Field average of the active layer, synchronised with the decision card. */
    average: string;
    legendLow: string;
    legendHigh: string;
    /** `{n}` `{area}` */
    zonesCount: string;
    hint: string;
    /** Marks the panel that shows the tapped zone. */
    selectedZone: string;
    /** Honest provenance note for the spatial model. */
    note: string;
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
    ruleHeatCondition: string;
    ruleWindTitle: string;
    ruleWindText: string;
    ruleWindCondition: string;
    ruleEt0Title: string;
    ruleEt0Text: string;
    ruleEt0Condition: string;
    ruleCalmTitle: string;
    ruleCalmText: string;
    ruleCalmCondition: string;
    activeRule: string;
    otherRulesShow: string;
    otherRulesHide: string;
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
    /** Peak badge above the highest bar / point, e.g. "أعلى 33°". `{value}` is the formatted value. */
    peakLabel: string;
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
  /**
   * Daily AI task checklist — merged INTO the hero decision card (it replaces
   * the old static advice lines and the standalone tasks card).
   */
  heroTasks: {
    title: string;
    subtitle: string;
    /** `{done}` `{total}` — progress counter beside the bar. */
    progress: string;
    /** `{done}` `{total}` — celebratory badge when every task is checked. */
    allDone: string;
    /** Category badges (the three task buckets). */
    categories: { irrigation: string; protection: string; fertilization: string };
    /** Priority indicators: High / Normal. */
    priorities: { high: string; normal: string };
    /** Accessible label of a task checkbox: `{title}`. */
    checkAria: string;
    /** Card footer — the AI publish stamp of the daily workflow. */
    updatedAi: string;
    /**
     * Collapsible checklist (mobile space saver): the pill under the first
     * task. `{count}` = how many tasks are hidden («عرض باقي المهام (3+) ▾»).
     * The chevron itself is an animated glyph, not part of the string.
     */
    showMore: string;
    /** Expanded twin of `showMore` — the pill collapses the list again. */
    collapse: string;
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
    perHaOpen: "لكل هكتار: عرض خطوات الحساب",
    perHaCta: "كيف حُسب؟",
  },
  flow: {
    title: "من أين جاء رقم الهكتار؟",
    subtitle: "{crop} في {wilaya} بنظام {system}، خطوة بخطوة حتى حجم القطعة.",
    hint: "اضغط على أي معامل لترى أثره في المعادلة.",
    stepLabel: "الخطوة {n}",
    resultTag: "الناتج",
    factorsTag: "المعاملات المؤثرة",
    climateTitle: "مدخلات المناخ",
    climateNote: "الحرارة والرطوبة والرياح تُدخل أولاً في معادلة التبخر المرجعي ET₀.",
    factorTemp: "الحرارة {temp}°",
    factorTempEffect: "الحرارة أساس المعادلة: 0.155 × {temp}° = {base}.",
    factorHumidity: "معامل الرطوبة {damp}",
    factorHumidityEffect: "رطوبة {humidity}% تُدخل معاملاً قدره {damp}، أي {pct} عن المعامل المحايد 1.00.",
    factorWind: "معامل الرياح {boost}",
    factorWindEffect: "ريح بـ{wind} كم/س تُدخل معاملاً قدره {boost}، أي {pct} عن المعامل المحايد 1.00.",
    cropTitle: "معامل المحصول والتربة",
    cropNote: "التبخر المرجعي يُضرب في معامل المحصول، ثم في معامل حالة التربة.",
    factorKc: "معامل {crop} {kc}",
    factorKcEffect: "كل مليمتر تبخر يتحول إلى {kc} مم احتياج فعلي لمحصول {crop}.",
    factorSoil: "معامل التربة {soilFactor}",
    factorSoilEffect: "تربة {soil} تعدّل الاحتياج بمعامل {soilFactor}، أي {pct} عن تربة مثالية.",
    efficiencyTitle: "كفاءة نظام السقي",
    efficiencyNote: "الاحتياج الصافي يُقسَم على كفاءة النظام حتى يغطي الماء المضاف الفاقد أثناء التوزيع.",
    factorEfficiency: "كفاءة السقي {efficiency}",
    factorEfficiencyEffect: "القسمة على {efficiency} ترفع الكمية بنسبة {pct} لتغطية الفاقد.",
    hectareTitle: "النتيجة للهكتار الواحد",
    hectareNote: "تحويل الملليمترات إلى لترات: كل 1 مم فوق هكتار واحد يساوي 10 000 لتر.",
    totalTitle: "إجمالي القطعة اليوم",
    totalNote: "الضرب في مساحة القطعة {area} هكتار، ثم التقريب إلى أقرب متر مكعب كما في بطاقة القرار.",
    precisionNote:
      "نعرض قيم الملليمتر بمنزليتين هنا حتى تكون سلسلة الضرب مطابقة تماماً للرقم النهائي، وبطاقة القرار تعرض نفس الكميات بمنزلة واحدة.",
    syncNote: "الرقمان أعلاه هما نفسهما المعروضان في بطاقة القرار: {litres} لتر لكل هكتار، و{daily} م³ للقطعة.",
  },
  heatmap: {
    title: "الخريطة الحرارية للقطعة",
    subtitle: "{zones} منطقة في {area} هكتار، توزيع تقديري حول متوسط اليوم نفسه.",
    layersAria: "طبقات الخريطة الحرارية",
    layers: { thermal: "الإجهاد الحراري", moisture: "الاحتياج المائي", transpiration: "مؤشر النتح" },
    zoneIds: [
      "أ",
      "ب",
      "ج",
      "د",
      "هـ",
      "و",
      "ز",
      "ح",
      "ط",
      "ي",
      "ك",
      "ل",
      "م",
      "ن",
      "س",
      "ع",
      "ف",
      "ص",
      "ق",
      "ر",
      "ش",
      "ت",
      "ث",
      "خ",
    ],
    zoneLabel: "المنطقة {id}",
    cellAria: "{zone}: {value} {unit}، {status}",
    units: { thermal: "مؤشر من 100", moisture: "لتر/هكتار", transpiration: "مؤشر من 100" },
    status: {
      moisture: { wet: "رطوبة عالية", balanced: "رطوبة متوازنة", mildDry: "جفاف خفيف", dry: "جفاف واضح" },
      thermal: { low: "إجهاد منخفض", moderate: "إجهاد متوسط", high: "إجهاد مرتفع", severe: "إجهاد حرج" },
      transpiration: { low: "نتح منخفض", moderate: "نتح متوسط", good: "نتح جيد", high: "نتح مرتفع" },
    },
    layerNote: {
      moisture: "تحتاج هذه المنطقة {value} لتر/هكتار اليوم، {delta}.",
      thermal: "مؤشر الإجهاد الحراري هنا {value} من 100، {delta}.",
      transpiration: "مؤشر النتح هنا {value} من 100، {delta}.",
    },
    deltaAbove: "أعلى بنسبة {pct}% من متوسط القطعة",
    deltaBelow: "أقل بنسبة {pct}% من متوسط القطعة",
    deltaEven: "مطابق تقريباً لمتوسط القطعة",
    average: "متوسط القطعة",
    legendLow: "أدنى",
    legendHigh: "أعلى",
    zonesCount: "{n} منطقة في {area} هكتار",
    hint: "اضغط على أي مربع لعرض تفاصيل المنطقة.",
    selectedZone: "المنطقة المحددة",
    note: "تقدير نموذجي للتوزيع المكاني داخل القطعة، مشتق من متوسط اليوم نفسه. يُستبدل بقراءات المستشعرات أو الأقمار الصناعية عند توصيلها.",
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
      "النافذة الصباحية ({window}) ثابتة حالياً ولم تُحسب من قراءات الساعة. نقترحها قبل ذروة التبخر، والقاعدة النشطة أدناه توضّح نصيحة الطقس اليوم.",
    rulesNote: "قواعد بطاقة الطقس تُطبَّق بالترتيب: الحرارة ثم الرياح ثم التبخر.",
    ruleHeatTitle: "حرارة 33° فأكثر",
    ruleHeatText: "الحرارة اليوم {temp}° → اسقِ قبل الثامنة صباحاً وتجنّب الرشّ ظهراً.",
    ruleHeatCondition: "إذا بلغت الحرارة هذه العتبة، اسقِ قبل الثامنة وتجنّب الرشّ ظهراً.",
    ruleWindTitle: "رياح 20 كم/س فأكثر",
    ruleWindText: "الرياح اليوم {wind} كم/س → خفّض ضغط الرشّ واسقِ صباحاً باكراً.",
    ruleWindCondition: "إذا بلغت الرياح هذه العتبة، خفّض ضغط الرشّ واسقِ صباحاً باكراً.",
    ruleEt0Title: "تبخر 5 مم/يوم فأكثر",
    ruleEt0Text: "التبخر اليوم {et0} مم/يوم → التزم بجدول السقي المعتاد.",
    ruleEt0Condition: "إذا بلغ التبخر هذه العتبة، التزم بجدول السقي المعتاد.",
    ruleCalmTitle: "ظروف معتدلة",
    ruleCalmText: "لا حرارة مرتفعة ولا رياح قوية ولا تبخر عالٍ → ظروف مناسبة للسقي اليوم.",
    ruleCalmCondition: "إذا لم تتحقق أي من العتبات السابقة، تكون ظروف السقي مناسبة.",
    activeRule: "القاعدة النشطة اليوم",
    otherRulesShow: "عرض قواعد القرار الأخرى",
    otherRulesHide: "إخفاء قواعد القرار الأخرى",
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
    peakLabel: "أعلى {value}",
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
  heroTasks: {
    title: "مهام اليوم الموصى بها (AI)",
    subtitle: "خطة يومية يولّدها الذكاء الاصطناعي من طقس قطعتك ومحصولها.",
    progress: "{done}/{total} مهام منجزة",
    allDone: "{done}/{total} اكتملت مهام اليوم 🎉",
    categories: { irrigation: "💧 سقي", protection: "🛡️ وقاية", fertilization: "🚜 تسميد/صيانة" },
    priorities: { high: "عالية", normal: "عادية" },
    checkAria: "تعليم المهمة كمنجزة: {title}",
    updatedAi: "✨ تم تحديث المهام بواسطة الذكاء الاصطناعي - اليوم 00:00",
    showMore: "عرض باقي المهام ({count}+)",
    collapse: "طي القائمة",
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
    perHaOpen: "Par hectare : voir les étapes du calcul",
    perHaCta: "Comment ?",
  },
  flow: {
    title: "D'où vient le chiffre par hectare ?",
    subtitle: "{crop} à {wilaya} en système {system}, étape par étape jusqu'au volume de la parcelle.",
    hint: "Touchez un coefficient pour voir son effet dans la formule.",
    stepLabel: "Étape {n}",
    resultTag: "Résultat",
    factorsTag: "Coefficients en jeu",
    climateTitle: "Données météo",
    climateNote: "Température, humidité et vent entrent d'abord dans la formule de l'évapotranspiration ET₀.",
    factorTemp: "Température {temp}°",
    factorTempEffect: "La température porte la formule : 0.155 × {temp}° = {base}.",
    factorHumidity: "Coefficient humidité {damp}",
    factorHumidityEffect: "L'humidité {humidity} % applique un coefficient de {damp}, soit {pct} par rapport au neutre 1.00.",
    factorWind: "Coefficient vent {boost}",
    factorWindEffect: "Un vent de {wind} km/h applique un coefficient de {boost}, soit {pct} par rapport au neutre 1.00.",
    cropTitle: "Coefficient cultural et sol",
    cropNote: "L'ET₀ de référence est multipliée par le coefficient cultural, puis par celui du sol.",
    factorKc: "Coefficient {crop} {kc}",
    factorKcEffect: "Chaque millimètre évaporé devient {kc} mm de besoin réel pour {crop}.",
    factorSoil: "Coefficient sol {soilFactor}",
    factorSoilEffect: "Le sol {soil} applique un coefficient de {soilFactor}, soit {pct} par rapport à un sol idéal.",
    efficiencyTitle: "Rendement du système d'irrigation",
    efficiencyNote: "Le besoin net est divisé par le rendement du système pour couvrir les pertes à la distribution.",
    factorEfficiency: "Rendement {efficiency}",
    factorEfficiencyEffect: "La division par {efficiency} majore le volume de {pct} pour couvrir les pertes.",
    hectareTitle: "Résultat pour un hectare",
    hectareNote: "Conversion des millimètres en litres : 1 mm sur 1 hectare vaut 10 000 litres.",
    totalTitle: "Total de la parcelle aujourd'hui",
    totalNote: "Multiplication par la surface de {area} hectares, puis arrondi au m³ le plus proche comme dans la carte de décision.",
    precisionNote:
      "Les millimètres sont affichés avec deux décimales pour que la chaîne de multiplication corresponde exactement au résultat final ; la carte de décision montre les mêmes quantités avec une décimale.",
    syncNote: "Les deux chiffres ci-dessus sont ceux de la carte de décision : {litres} L par hectare et {daily} m³ pour la parcelle.",
  },
  heatmap: {
    title: "Carte thermique de la parcelle",
    subtitle: "{zones} zones sur {area} hectares, répartition estimée autour de la moyenne du jour.",
    layersAria: "Couches de la carte thermique",
    layers: { thermal: "Stress thermique", moisture: "Besoin en eau", transpiration: "Transpiration" },
    zoneIds: [
      "A",
      "B",
      "C",
      "D",
      "E",
      "F",
      "G",
      "H",
      "I",
      "J",
      "K",
      "L",
      "M",
      "N",
      "O",
      "P",
      "Q",
      "R",
      "S",
      "T",
      "U",
      "V",
      "W",
      "X",
    ],
    zoneLabel: "Zone {id}",
    cellAria: "{zone} : {value} {unit}, {status}",
    units: { thermal: "indice sur 100", moisture: "L/ha", transpiration: "indice sur 100" },
    status: {
      moisture: { wet: "humidité élevée", balanced: "humidité équilibrée", mildDry: "léger déficit", dry: "déficit marqué" },
      thermal: { low: "stress faible", moderate: "stress modéré", high: "stress élevé", severe: "stress critique" },
      transpiration: { low: "transpiration faible", moderate: "transpiration moyenne", good: "transpiration bonne", high: "transpiration élevée" },
    },
    layerNote: {
      moisture: "Cette zone demande {value} L/ha aujourd'hui, {delta}.",
      thermal: "L'indice de stress thermique ici est de {value} sur 100, {delta}.",
      transpiration: "L'indice de transpiration ici est de {value} sur 100, {delta}.",
    },
    deltaAbove: "{pct} % au-dessus de la moyenne de la parcelle",
    deltaBelow: "{pct} % en dessous de la moyenne de la parcelle",
    deltaEven: "proche de la moyenne de la parcelle",
    average: "Moyenne de la parcelle",
    legendLow: "Min",
    legendHigh: "Max",
    zonesCount: "{n} zones sur {area} hectares",
    hint: "Touchez une cellule pour lire le détail de la zone.",
    selectedZone: "Zone sélectionnée",
    note: "Estimation modèle de la répartition spatiale dans la parcelle, dérivée de la moyenne du jour. Elle sera remplacée par les relevés capteurs ou satellite dès leur branchement.",
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
      "La fenêtre du matin ({window}) est fixe pour l'instant, et non calculée à partir de données horaires. Elle précède le pic d'évaporation ; la règle active ci-dessous explique le conseil météo du jour.",
    rulesNote: "Les règles de la carte météo s'appliquent dans l'ordre : chaleur, puis vent, puis évapotranspiration.",
    ruleHeatTitle: "Chaleur ≥ 33 °",
    ruleHeatText: "Température du jour {temp}° → irriguez avant 8 h et évitez l'aspersion à midi.",
    ruleHeatCondition: "Si ce seuil de chaleur est atteint, irriguez avant 8 h et évitez l'aspersion à midi.",
    ruleWindTitle: "Vent ≥ 20 km/h",
    ruleWindText: "Vent du jour {wind} km/h → baissez la pression d'aspersion et arrosez tôt le matin.",
    ruleWindCondition: "Si ce seuil de vent est atteint, baissez la pression d'aspersion et arrosez tôt le matin.",
    ruleEt0Title: "Évapotranspiration ≥ 5 mm/jour",
    ruleEt0Text: "Évapotranspiration du jour {et0} mm/jour → gardez le planning d'irrigation du jour.",
    ruleEt0Condition: "Si ce seuil d'évapotranspiration est atteint, gardez le planning d'irrigation du jour.",
    ruleCalmTitle: "Conditions modérées",
    ruleCalmText: "Ni forte chaleur, ni vent fort, ni forte évaporation → conditions favorables à l'irrigation aujourd'hui.",
    ruleCalmCondition: "Si aucun des seuils précédents n'est atteint, les conditions sont favorables à l'irrigation.",
    activeRule: "Règle active aujourd'hui",
    otherRulesShow: "Voir les autres règles de décision",
    otherRulesHide: "Masquer les autres règles de décision",
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
    peakLabel: "Max {value}",
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
  heroTasks: {
    title: "Tâches du jour recommandées (AI)",
    subtitle: "Plan quotidien généré par l'IA à partir de la météo et de la culture de votre parcelle.",
    progress: "{done}/{total} tâches accomplies",
    allDone: "{done}/{total} tâches du jour accomplies 🎉",
    categories: {
      irrigation: "💧 Irrigation",
      protection: "🛡️ Protection",
      fertilization: "🚜 Fertilisation/entretien",
    },
    priorities: { high: "Haute", normal: "Normale" },
    checkAria: "Marquer la tâche comme accomplie : {title}",
    updatedAi: "✨ Mises à jour par l'IA - aujourd'hui 00:00",
    showMore: "Afficher les autres tâches ({count}+)",
    collapse: "Replier la liste",
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
