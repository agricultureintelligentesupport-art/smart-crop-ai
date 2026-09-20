import type { Metadata } from "next";
import AuthFlow from "@/components/auth/AuthFlow";

export const metadata: Metadata = {
  title: "تسجيل الدخول · Connexion",
  description:
    "سجّل الدخول بحساب Google أو برقم هاتفك أو ببريدك الإلكتروني. / Connectez-vous avec Google, votre téléphone ou votre e-mail.",
};

export default function LoginPage() {
  return <AuthFlow initialMode="signin" />;
}
