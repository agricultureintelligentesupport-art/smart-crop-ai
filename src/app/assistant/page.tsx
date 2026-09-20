import type { Metadata } from "next";
import AssistantView from "@/components/assistant/AssistantView";

export const metadata: Metadata = {
  title: "المساعد الذكي · Assistant IA",
  description:
    "مستشارك الزراعي الجزائري: تشخيص أمراض النباتات بالصور وخطط علاج ووقاية محلية بالذكاء الاصطناعي. / Assistant agricole IA : diagnostic des maladies par photo et plans de traitement localisés.",
};

/**
 * AI agricultural assistant. Hybrid pipeline: Hugging Face PlantVillage
 * vision diagnosis + Gemini 2.0 Flash localized reasoning (see
 * `/api/assistant`). Session-gated like the dashboard.
 */
export default function AssistantPage() {
  return <AssistantView />;
}
