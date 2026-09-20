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
    thinkingVision: string;
    error: string;
    retry: string;
    offlineNote: string;
    visionOnlyNote: string;
  };
  diagnosis: {
    title: string;
    confidence: string;
    model: string;
    healthy: string;
    alternatives: string;
    confidenceHigh: string;
    confidenceMedium: string;
    confidenceLow: string;
  };
}

const AR: AssistantCopy = {
  header: {
    title: "المساعد الذكي",
    subtitle: "مستشارك الزراعي الجزائري",
    navDashboard: "لوحة التحكم",
    navHome: "الرئيسية",
    langAr: "العربية",
    langFr: "Français",
  },
  hero: {
    greeting: "أهلاً بيك! 👋",
    intro:
      "أنا مستشارك الزراعي الذكي. صوّر ورقة النبتة المريضة أو اسألني عن السقي، التسميد، أو أي شيء يخص محصولك — نجاوبك حسب ولايتك ومحصولك.",
  },
  chips: [
    { label: "تشخيص مرض الأوراق 📸", message: "شخّص لي مرض هذه الورقة وأعطني خطة علاج مناسبة لمنطقتي.", withImage: true },
    { label: "جدول السقي لولايتي 💧", message: "أعطني جدول سقي أسبوعي مناسب لمحصولي وولايتي في هذا الموسم." },
    { label: "برنامج تسميد 🌱", message: "ما هو برنامج التسميد المناسب لمحصولي المفضل في هذه الفترة؟" },
    { label: "وقاية من الآفات 🛡️", message: "كيف أحمي محصولي من الآفات والأمراض الشائعة في ولايتي هذا الموسم؟" },
  ],
  composer: {
    placeholder: "اكتب سؤالك… أو أرفق صورة ورقة النبتة",
    send: "إرسال",
    attach: "إرفاق صورة",
    removeImage: "إزالة الصورة",
    imageAlt: "معاينة الصورة المرفقة",
    imageTooLarge: "الصورة كبيرة جداً — الحد الأقصى 8 ميغابايت.",
    imageUnreadable: "تعذّرت قراءة الصورة، جرّب صورة أخرى.",
  },
  chat: {
    you: "أنت",
    assistant: "المساعد الذكي",
    thinking: "جارٍ تحضير الإجابة…",
    thinkingVision: "جارٍ تحليل الصورة وتشخيص المرض…",
    error: "وقع خطأ أثناء الاتصال بالمساعد. حاول مرة أخرى.",
    retry: "إعادة المحاولة",
    offlineNote: "وضع محدود: مفاتيح الذكاء الاصطناعي غير مضبوطة على الخادم.",
    visionOnlyNote: "تم التشخيص بالصورة فقط — نصائح عامة (Gemini غير متاح).",
  },
  diagnosis: {
    title: "نتيجة تشخيص الصورة",
    confidence: "نسبة الثقة",
    model: "نموذج التصنيف",
    healthy: "النبتة سليمة",
    alternatives: "احتمالات أخرى",
    confidenceHigh: "ثقة مرتفعة",
    confidenceMedium: "ثقة متوسطة",
    confidenceLow: "ثقة منخفضة — جرّب صورة أوضح",
  },
};

const FR: AssistantCopy = {
  header: {
    title: "Assistant intelligent",
    subtitle: "Votre conseiller agricole algérien",
    navDashboard: "Tableau de bord",
    navHome: "Accueil",
    langAr: "العربية",
    langFr: "Français",
  },
  hero: {
    greeting: "Bienvenue ! 👋",
    intro:
      "Je suis votre conseiller agricole IA. Photographiez une feuille malade ou posez vos questions d'irrigation et de fertilisation — réponses adaptées à votre wilaya et votre culture.",
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
    assistant: "Assistant",
    thinking: "Préparation de la réponse…",
    thinkingVision: "Analyse de l'image et diagnostic en cours…",
    error: "Erreur de connexion à l'assistant. Réessayez.",
    retry: "Réessayer",
    offlineNote: "Mode limité : clés IA non configurées sur le serveur.",
    visionOnlyNote: "Diagnostic image seul — conseils généraux (Gemini indisponible).",
  },
  diagnosis: {
    title: "Résultat du diagnostic visuel",
    confidence: "Confiance",
    model: "Modèle de classification",
    healthy: "Plante saine",
    alternatives: "Autres possibilités",
    confidenceHigh: "Confiance élevée",
    confidenceMedium: "Confiance moyenne",
    confidenceLow: "Confiance faible — photo plus nette conseillée",
  },
};

export const ASSISTANT: Record<Lang, AssistantCopy> = { ar: AR, fr: FR };
