/**
 * Bilingual copy for the AI assistant screen. Same shape-first convention as
 * `lib/dashboard/copy.ts`: `AR` defines the contract.
 */

import type { Lang } from "@/lib/wilayas";

export interface AssistantCopy {
  header: {
    title: string;
    subtitle: string;
    navDashboard: string;
    navHome: string;
    langAr: string;
    langFr: string;
  };
  hero: {
    greeting: string;
    intro: string;
  };
  chips: { label: string; message: string; withImage?: boolean }[];
  composer: {
    placeholder: string;
    send: string;
    attach: string;
    removeImage: string;
    imageAlt: string;
    imageTooLarge: string;
    imageUnreadable: string;
  };
  chat: {
    you: string;
    assistant: string;
    thinking: string;
    /** Image requests: analysis + reply (the cropping pre-step is removed). */
    thinkingVision: string;
    error: string;
    retry: string;
    unavailable: string;
    visionOnlyNote: string;
  };
  /**
   * Manual model selector. The option LABELS come from
   * `@/lib/assistant/model-choice` (`phyto 3.8` …) so the picker and the API
   * agree; everything here is the surrounding chrome.
   */
  model: {
    label: string;
    aria: string;
    /** Tooltip prefix: "Selected: phyto 3.5 — fast". */
    selected: string;
    /** One-line characterisation per `PhytoModelChoice.note`. */
    notes: Record<"balanced" | "fast" | "economy", string>;
  };
  diagnosis: {
    title: string;
    confidence: string;
    /** Accessibility label for the green dot — Gemini (primary) produced the analysis. */
    byGemini: string;
    /** Accessibility label for the amber dot — fallback model produced the analysis. */
    byFallback: string;
    healthy: string;
    alternatives: string;
    confidenceHigh: string;
    confidenceMedium: string;
    confidenceLow: string;
  };
}

const AR: AssistantCopy = {
  header: {
    title: "PhytoScan AI",
    subtitle: "مستشارك الزراعي الجزائري",
    navDashboard: "لوحة التحكم",
    navHome: "الرئيسية",
    langAr: "العربية",
    langFr: "Français",
  },
  hero: {
    greeting: "مرحباً بك في PhytoScan AI 🌿",
    intro:
      "طبيب محاصيلك ومستشارك الزراعي حاضر معك في الحقل. صوّر أي ورقة تبدو عليها علامات المرض للتشخيص الفوري، أو استشرني حول برامج السقي، التسميد والوقاية — خطوة بخطوة حسب مناخ ولايتك ونوع محصولك.",
  },
  chips: [
    { label: "تشخيص مرض الأوراق 📸", message: "شخّص لي مرض هذه الورقة وأعطني خطة علاج مناسبة لمنطقتي.", withImage: true },
    { label: "جدول السقي لولايتي 💧", message: "أعطني جدول سقي أسبوعي مناسب لمحصولي وولايتي في هذا الموسم." },
    { label: "برنامج تسميد 🌱", message: "ما هو برنامج التسميد المناسب لمحصولي المفضل في هذه الفترة؟" },
    { label: "وقاية من الآفات 🛡️", message: "كيف أحمي محصولي من الآفات والأمراض الشائعة في ولايتي هذا الموسم؟" },
  ],
  composer: {
    placeholder: "اكتب سؤالك…",
    send: "إرسال",
    attach: "إرفاق صورة",
    removeImage: "إزالة الصورة",
    imageAlt: "معاينة الصورة المرفقة",
    imageTooLarge: "الصورة كبيرة جداً — الحد الأقصى 8 ميغابايت.",
    imageUnreadable: "تعذّرت قراءة الصورة، جرّب صورة أخرى.",
  },
  chat: {
    you: "أنت",
    assistant: "PhytoScan AI",
    thinking: "جارٍ تحضير الإجابة…",
    thinkingVision: "جارٍ تحليل الصورة وتشخيص المرض…",
    error: "وقع خطأ أثناء الاتصال بالمساعد. حاول مرة أخرى.",
    retry: "إعادة المحاولة",
    unavailable: "خدمة المساعد غير متاحة حالياً. يرجى المحاولة لاحقاً.",
    visionOnlyNote: "تم التشخيص بالصورة فقط — نصائح عامة (نموذج اللغة غير متاح).",
  },
  model: {
    label: "النموذج",
    aria: "اختر نموذج الذكاء الاصطناعي المستخدم في الإجابة",
    selected: "النموذج المختار",
    notes: {
      balanced: "متوازن — الأدق للإجابة والتشخيص",
      fast: "سريع — إجابات أسرع",
      economy: "اقتصادي — استهلاك أقل للحصّة",
    },
  },
  diagnosis: {
    title: "نتيجة تشخيص الصورة",
    confidence: "نسبة الثقة",
    byGemini: "تم التحليل بواسطة Gemini",
    byFallback: "تم التحليل بواسطة النموذج الاحتياطي",
    healthy: "النبتة سليمة",
    alternatives: "احتمالات أخرى",
    confidenceHigh: "ثقة مرتفعة",
    confidenceMedium: "ثقة متوسطة",
    confidenceLow: "ثقة منخفضة — جرّب صورة أوضح",
  },
};

const FR: AssistantCopy = {
  header: {
    title: "PhytoScan AI",
    subtitle: "Votre conseiller agricole algérien",
    navDashboard: "Tableau de bord",
    navHome: "Accueil",
    langAr: "العربية",
    langFr: "Français",
  },
  hero: {
    greeting: "Bienvenue sur PhytoScan AI 🌿",
    intro:
      "Votre expert phytosanitaire et conseiller de terrain au quotidien. Prenez en photo une feuille suspecte pour un diagnostic immédiat des maladies, ou demandez conseil pour vos cycles d'irrigation, de fertilisation et de traitement — des recommandations sur-mesure pour votre wilaya et vos cultures.",
  },
  chips: [
    { label: "Diagnostic de feuille 📸", message: "Diagnostique la maladie de cette feuille et propose un plan de traitement adapté à ma région.", withImage: true },
    { label: "Planning d'irrigation 💧", message: "Donne-moi un planning d'irrigation hebdomadaire adapté à ma culture et ma wilaya en cette saison." },
    { label: "Programme de fertilisation 🌱", message: "Quel programme de fertilisation pour ma culture préférée en cette période ?" },
    { label: "Prévention des ravageurs 🛡️", message: "Comment protéger ma culture des ravageurs et maladies courants dans ma wilaya cette saison ?" },
  ],
  composer: {
    placeholder: "Écrivez votre question… ou joignez une photo de feuille",
    send: "Envoyer",
    attach: "Joindre une image",
    removeImage: "Retirer l'image",
    imageAlt: "Aperçu de l'image jointe",
    imageTooLarge: "Image trop lourde — 8 Mo maximum.",
    imageUnreadable: "Image illisible, essayez une autre photo.",
  },
  chat: {
    you: "Vous",
    assistant: "PhytoScan AI",
    thinking: "Préparation de la réponse…",
    thinkingVision: "Analyse de l'image et diagnostic en cours…",
    error: "Erreur de connexion à l'assistant. Réessayez.",
    retry: "Réessayer",
    unavailable: "Le service assistant est indisponible pour le moment. Réessayez plus tard.",
    visionOnlyNote: "Diagnostic image seul — conseils généraux (modèle de langage indisponible).",
  },
  model: {
    label: "Modèle",
    aria: "Choisir le modèle d'IA utilisé pour la réponse",
    selected: "Modèle sélectionné",
    notes: {
      balanced: "Équilibré — le plus précis",
      fast: "Rapide — réponses plus vives",
      economy: "Économique — moins de quota",
    },
  },
  diagnosis: {
    title: "Résultat du diagnostic visuel",
    confidence: "Confiance",
    byGemini: "Analysé par Gemini",
    byFallback: "Analysé par le modèle de secours",
    healthy: "Plante saine",
    alternatives: "Autres possibilités",
    confidenceHigh: "Confiance élevée",
    confidenceMedium: "Confiance moyenne",
    confidenceLow: "Confiance faible — photo plus nette conseillée",
  },
};

export const ASSISTANT: Record<Lang, AssistantCopy> = { ar: AR, fr: FR };
