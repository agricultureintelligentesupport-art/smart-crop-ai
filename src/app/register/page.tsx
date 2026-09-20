import type { Metadata } from "next";
import NextStep from "@/components/NextStep";

export const metadata: Metadata = { title: "إنشاء حساب · Créer un compte" };

function UserPlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-8 w-8" aria-hidden>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M19 8v6" />
      <path d="M22 11h-6" />
    </svg>
  );
}

export default function RegisterPage() {
  return (
    <NextStep
      icon={<UserPlusIcon />}
      titleAr="إنشاء حساب جديد"
      titleFr="Créer un nouveau compte"
      descAr="سيتم ربط هذه الخطوة بنموذج التسجيل الكامل في المرحلة القادمة."
      descFr="This step will open the full sign-up form in the next milestone."
    />
  );
}
