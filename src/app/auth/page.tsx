import type { Metadata } from "next";
import AuthFlow from "@/components/auth/AuthFlow";

export const metadata: Metadata = {
  title: "الدخول إلى محصولي الذكي · Connexion",
  description:
    "اختر طريقة الدخول (Google أو الهاتف أو البريد)، حدّد صفتك وولايتك، وابدأ مباشرة. / Choisissez votre méthode de connexion, votre profil et votre wilaya.",
};

export default function AuthPage() {
  return <AuthFlow initialMode="signin" />;
}
