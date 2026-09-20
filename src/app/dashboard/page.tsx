import type { Metadata } from "next";
import DashboardView from "@/components/dashboard/DashboardView";

export const metadata: Metadata = {
  title: "لوحة التحكم · Tableau de bord",
  description:
    "لوحة الزراعة الدقيقة: الطقس، السقي، تشخيص النبات ومؤشر الأقمار الصناعية. / Tableau de bord d'agriculture de précision : météo, irrigation, diagnostic et NDVI.",
};

/** Member dashboard. Redirects to /auth when no session is stored on the device. */
export default function DashboardPage() {
  return <DashboardView mode="member" />;
}
