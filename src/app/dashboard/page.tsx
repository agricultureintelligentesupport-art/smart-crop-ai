import type { Metadata } from "next";
import DashboardView from "@/components/dashboard/DashboardView";

export const metadata: Metadata = {
  title: "لوحة التحكم · Tableau de bord",
  description:
    "لوحة الزراعة الدقيقة: الطقس، السقي، تشخيص النبات ومؤشر الأقمار الصناعية. / Tableau de bord d'agriculture de précision : météo, irrigation, diagnostic et NDVI.",
};

/**
 * Member dashboard. Strictly session-gated: it requires an authenticated user
 * (Google, phone or e-mail); anyone else is redirected to the auth wizard.
 */
export default function DashboardPage() {
  return <DashboardView />;
}
