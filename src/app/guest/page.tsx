import type { Metadata } from "next";
import DashboardView from "@/components/dashboard/DashboardView";

export const metadata: Metadata = {
  title: "متابعة كزائر · Mode invité",
  description:
    "لوحة الزائر: طقس ولايتك، حاسبة السقي، تشخيص الأوراق ومؤشر الغطاء النباتي، بدون إنشاء حساب. / Tableau de bord invité : météo, irrigation, diagnostic foliaire et NDVI.",
};

/**
 * Guest mode lands straight on the dashboard: the record is created on the
 * device (localStorage) and every widget is interactive. No intermediate
 * "coming soon" screen.
 */
export default function GuestPage() {
  return <DashboardView mode="guest" />;
}
