import type { Metadata } from "next";
import AuthWorkflow from "@/components/auth/AuthWorkflow";

export const metadata: Metadata = {
  title: "تسجيل الدخول · Smart Crop",
  description: "أنشئ حسابك في Smart Crop وابدأ الزراعة بذكاء.",
};

export default function AuthPage() {
  return <AuthWorkflow />;
}
