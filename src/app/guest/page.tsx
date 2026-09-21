"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { enterGuestMode } from "@/lib/auth/guest";

/**
 * Guest entry route: claims the local guest flag and forwards straight to
 * the dashboard. This is the URL twin of the "المتابعة كزائر" button on the
 * auth wizard — same storage key, same bypass, no Firebase involvement.
 */
export default function GuestPage() {
  const router = useRouter();

  useEffect(() => {
    enterGuestMode();
    router.replace("/dashboard");
  }, [router]);

  return null;
}
