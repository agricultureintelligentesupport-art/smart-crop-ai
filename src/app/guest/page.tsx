import type { Metadata } from "next";
import NextStep from "@/components/NextStep";

export const metadata: Metadata = { title: "متابعة كزائر · Continuer comme invité" };

function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-8 w-8" aria-hidden>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export default function GuestPage() {
  return (
    <NextStep
      icon={<EyeIcon />}
      titleAr="وضع الزائر"
      titleFr="Mode invité"
      descAr="سيتم تحويلك إلى لوحة استعراض سريعة بدون حساب، مع الحفاظ على بياناتك مؤقتة."
      descFr="You will land on a quick guest dashboard with temporary local data."
    />
  );
}
