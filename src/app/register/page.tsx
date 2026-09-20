import type { Metadata } from "next";
import AuthFlow from "@/components/auth/AuthFlow";

export const metadata: Metadata = {
  title: "إنشاء حساب · Créer un compte",
  description:
    "أنشئ حسابك في دقيقة: طريقة الدخول، الصفة، ثم الولاية لتخصيص الطقس والمحاصيل. / Créez votre compte en une minute : méthode, profil puis wilaya.",
};

export default function RegisterPage() {
  return <AuthFlow initialMode="register" />;
}
