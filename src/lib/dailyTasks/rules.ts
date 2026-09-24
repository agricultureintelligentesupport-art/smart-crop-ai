/**
 * Rule-based daily task generator — the offline fallback that guarantees the
 * checklist is never empty.
 *
 * Same context payload as the AI stage (`DailyContext`), deterministic, pure
 * TypeScript: runs in the cron handler when every LLM key is down AND in the
 * browser when even `/api/daily-tasks` is unreachable. Produces 3–5 tailored
 * tasks in the exact JSON shape the AI is asked for (bilingual), so the two
 * generators are drop-in interchangeable.
 */

import type { DailyContext } from "./context";
import type { DailyTask, TaskCategory, TaskPriority } from "./types";

const round1 = (n: number) => Math.round(n * 10) / 10;
/** One decimal — the exact m³/°C style the hero card and the AI samples use. */
const fmt1 = (n: number) => round1(n).toFixed(1);

const SYSTEM_AR: Record<DailyContext["system"], string> = {
  drip: "التنقيط",
  sprinkler: "الرشّ",
  furrow: "الغمر",
};
const SYSTEM_FR: Record<DailyContext["system"], string> = {
  drip: "goutte à goutte",
  sprinkler: "aspersion",
  furrow: "gravitaire",
};

/**
 * Plant-protection risk names per crop family — used for the humidity-driven
 * fungal-watch task (e.g. durum wheat + 69 % humidity → yellow rust).
 */
const RUST_AR: Partial<Record<DailyContext["crop"]["key"], string>> = {
  wheat: "الصدأ الصفرائي",
  barley: "الصدأ الصدئي",
  tomato: "اللفحة المبكرة",
  potato: "اللفحة المتأخرة",
  grape: "البياض الدقيقي",
  olive: "العيون البكتيرية",
  citrus: "الأرميلاريا",
  onion: "العفن البوغي",
  faba: "البقع البكتيرية",
  pea: "البياض الدقيقي",
  alfalfa: "الصدأ",
};
const RUST_FR: Partial<Record<DailyContext["crop"]["key"], string>> = {
  wheat: "la rouille jaune",
  barley: "la rouille brune",
  tomato: "l'alternariose",
  potato: "le mildiou",
  grape: "l'oïdium",
  olive: "l'œil de paon",
  citrus: "l'armillaire",
  onion: "la botrytis",
  faba: "les taches bactériennes",
  pea: "l'oïdium",
  alfalfa: "la rouille",
};

/** Fertilisation advice keyed by growth-stage keyword (AR stage label). */
function nutritionTask(ctx: DailyContext): { title: string; subtitle: string; titleFr: string; subtitleFr: string } {
  const stage = ctx.growthStage.ar;
  const crop = ctx.crop.ar;
  const cropFr = ctx.crop.fr;
  if (/تشجير|إشراط|نمو خضري|إنبات/.test(stage)) {
    return {
      title: "جرعة آزوتية مساندة للنمو الخضري",
      subtitle: `دفعة خفيفة من الآزوت (20–30 كغ/هكتار) لمرحلة ${stage} في ${crop}، مع سقي خفيف للتوزيع.`,
      titleFr: "Apport azoté de soutien",
      subtitleFr: `20–30 kg N/ha au stade « ${ctx.growthStage.fr} » de ${cropFr}, suivi d'une irrigation légère.`,
    };
  }
  if (/إزهار|عقد|تعبئة|ثمار|حبوب|جذاذ/.test(stage)) {
    return {
      title: "سماد فوسفاتي–بوتاسي لدعم الإثمار",
      subtitle: `جرعة فوسفات وبوتاسيوم لدعم ${stage} في ${crop} وتحسين تعبئة الحبوب/الثمار.`,
      titleFr: "Fertilisation phospho-potassique",
      subtitleFr: `Apport P–K au stade « ${ctx.growthStage.fr} » de ${cropFr} pour soutenir la fructification.`,
    };
  }
  if (/حصاد|جذاذ|رطب|نضج/.test(stage)) {
    return {
      title: "تنظيف وتسميد ما بعد الحصاد",
      subtitle: `أزل بقايا ${crop} وأعد تسميد التربة استعداداً للدورة المقبلة.`,
      titleFr: "Entretien post-récolte",
      subtitleFr: `Nettoyage des résidus de ${cropFr} et re-fertilisation du sol pour le prochain cycle.`,
    };
  }
  return {
    title: "فحص ذوبان الأسمدة ومتابعة التغذية",
    subtitle: `تحقق من ذوبان الأسمدة في تربة ${ctx.soil.ar} وراجع برنامج التغذية لمرحلة ${stage}.`,
    titleFr: "Contrôle de la fertilisation",
    subtitleFr: `Vérifier la dissolution des engrais sur sol ${ctx.soil.fr} au stade « ${ctx.growthStage.fr} ».`,
  };
}

/**
 * Builds the day's task list from the context — 3 to 5 tasks, irrigation
 * first (its subtitle quotes the card's exact m³ + window), then the dominant
 * weather risk, then nutrition/operations and a monitoring round.
 */
export function generateRuleTasks(ctx: DailyContext): DailyTask[] {
  const { weather, system, wateringWindow } = ctx;
  const windowStr = `${wateringWindow.from} - ${wateringWindow.to}`;
  const windowStrFr = windowStr.replace(" - ", " – ");
  const cropAr = ctx.crop.ar;
  const cropFr = ctx.crop.fr;
  const tasks: Array<Omit<DailyTask, "id">> = [];

  /* ---- 1. Irrigation (always) ------------------------------------- */
  const heavyRain = weather.rainProbabilityPct >= 60;
  if (heavyRain) {
    tasks.push({
      title: "تقليل أو تأجيل حصة السقي",
      subtitle: `احتمال مطر ${weather.rainProbabilityPct}% اليوم؛ قد يغطي جزءاً من حاجتها البالغة ${fmt1(ctx.netIrrigationM3)} م³ — راقب التربة قبل الضخ.`,
      category: "irrigation",
      priority: "high",
      titleFr: "Réduire ou reporter l'irrigation",
      subtitleFr: `Risque de pluie ${weather.rainProbabilityPct} % ; surveiller le sol avant de pomper les ${ctx.netIrrigationM3} m³ prévus.`,
    });
  } else {
    const urgent = ctx.activeRule === "heat" || ctx.activeRule === "et0";
    tasks.push({
      title: `تشغيل نظام السقي ب${SYSTEM_AR[system]}`,
      subtitle: `ضخ ${fmt1(ctx.netIrrigationM3)}م³ خلال النافذة ${windowStr}`,
      category: "irrigation",
      priority: urgent ? "high" : "normal",
      titleFr: `Lancer l'irrigation ${SYSTEM_FR[system]}`,
      subtitleFr: `Purger ${fmt1(ctx.netIrrigationM3)} m³ pendant la fenêtre ${windowStrFr}`,
    });
    if (ctx.activeRule === "heat") {
    tasks.push({
      title: "تقديم السقي قبل موجة الحرارة",
      subtitle: `أعلى حرارة متوقعة ${fmt1(weather.tempMaxC)} درجة — أنهِ الضخ قبل الساعة 08:00 وتجنّب الرشّ الظهيرة.`,
        category: "irrigation",
        priority: "high",
        titleFr: "Irriguer avant la canicule",
        subtitleFr: `Maximum prévu ${fmt1(weather.tempMaxC)} °C — finir avant 08:00 et éviter l'aspersion à midi.`,
      });
    }
  }

  /* ---- 2. Protection — the dominant risk of the day ---------------- */
  const riskAr = RUST_AR[ctx.crop.key] ?? "الأمراض الفطرية";
  const riskFr = RUST_FR[ctx.crop.key] ?? "les maladies fongiques";
  if (weather.humidityPct >= 60) {
    tasks.push({
      title: `تفقد الفطريات بالجهة الشمالية${ctx.crop.key === "wheat" ? "" : ` في ${cropAr}`}`,
      subtitle: `ارتفاع الرطوبة (${weather.humidityPct}%) يزيد مخاطر ${riskAr}`,
      category: "protection",
      priority: weather.humidityPct >= 75 ? "high" : "normal",
      titleFr: "Inspecter les foyers fongiques (versant nord)",
      subtitleFr: `Humidité élevée (${weather.humidityPct} %) : risque accru de ${riskFr}.`,
    });
  } else if (weather.windKph >= 20) {
    tasks.push({
      title: "فحص شبكة السقي بعد الرياح",
      subtitle: `رياح ${weather.windKph} كم/س — نظّف النقاطات المغطاة بالرمل واضبط ضغط نظام ${SYSTEM_AR[system]}.`,
      category: "protection",
      priority: "high",
      titleFr: "Vérifier le réseau après le vent",
      subtitleFr: `Vent ${weather.windKph} km/h — nettoyer les goutteurs ensablés et régler la pression (système ${SYSTEM_FR[system]}).`,
    });
  } else {
    tasks.push({
      title: `جولة وقاية على ${cropAr}`,
      subtitle: `افحص الأوراق والسوق في مرحلة ${ctx.growthStage.ar} وابحث عن آثار الإصابة المبكرة.`,
      category: "protection",
      priority: "normal",
      titleFr: `Tournée de protection — ${cropFr}`,
      subtitleFr: `Examiner feuilles et tiges au stade « ${ctx.growthStage.fr} » pour tout signe précoce.`,
    });
  }
  if (weather.windKph >= 20 && weather.humidityPct >= 60) {
    // Both risks present — worth its own line (still capped at 5 below).
    tasks.push({
      title: "تثبيت الشبكة ورفع مكافحة الفطريات",
      subtitle: `رياح ${weather.windKph} كم/س مع رطوبة ${weather.humidityPct}% — ثبّت الخطوط واقضِ على بؤر ${riskAr}.`,
      category: "protection",
      priority: "high",
      titleFr: "Sécuriser le réseau et traiter les foyers",
      subtitleFr: `Vent ${weather.windKph} km/h + humidité ${weather.humidityPct} % : fixer les lignes et éradiquer ${riskFr}.`,
    });
  }

  /* ---- 3. Nutrition / operations ----------------------------------- */
  const nutrition = nutritionTask(ctx);
  tasks.push({
    title: nutrition.title,
    subtitle: nutrition.subtitle,
    category: "fertilization",
    priority: "normal",
    titleFr: nutrition.titleFr,
    subtitleFr: nutrition.subtitleFr,
  });

  /* ---- 4. Monitoring round ----------------------------------------- */
  tasks.push({
    title: `مسح ${cropAr} وتسجيل ملاحظات المرحلة`,
    subtitle: `صوّر 5 عينات أوراق من نقاط مختلفة وسجّل ملاحظات مرحلة ${ctx.growthStage.ar} (${ctx.wilaya.nameAr}).`,
    category: "protection",
    priority: "normal",
    titleFr: `Relevé ${cropFr} et notes de stade`,
    subtitleFr: `Photographier 5 échantillons de feuilles et noter le stade « ${ctx.growthStage.fr} » (${ctx.wilaya.nameFr}).`,
  });

  // 3–5 tasks: keep the strongest (first) five — order is already priority.
  return tasks.slice(0, 5).map((t, i) => ({
    id: `t${i + 1}`,
    ...t,
    category: t.category as TaskCategory,
    priority: t.priority as TaskPriority,
  }));
}
