"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { enterGuestMode } from "@/lib/auth/guest";
import { useLang } from "@/lib/use-lang";

/**
 * Guest entry point: sets a `local_guest_*` profile (`isGuest: true`,
 * `displayName: "زائر"`) and forwards straight to the dashboard.
 * This restores the rapid testing bypass without touching Firebase flows.
 */
export default function GuestPage() {
  const router = useRouter();
  const { lang } = useLang("ar");

  useEffect(() => {
    enterGuestMode(lang);
    router.replace("/dashboard");
  }, [lang, router]);

  return (
    <div className="grid min-h-screen place-items-center bg-[#F4FBF7] p-6 text-emerald-900">
      <p className="animate-pulse text-[13px] font-black">جارٍ الدخول كزائر…</p>
    </div>
  );
}
