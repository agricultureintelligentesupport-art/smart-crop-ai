/**
 * Copy for the signed-in app shell (top bar, bottom tab bar, sheets).
 *
 * Same shape-first convention as `lib/dashboard/copy.ts`: `AR` defines the
 * contract and `FR` mirrors it. Kept out of the per-screen copy files because
 * the shell is shared by `/dashboard` and `/assistant`.
 */

import type { Lang } from "@/lib/wilayas";

export interface AppShellCopy {
  /** Short labels, they sit under an icon in the tab bar. */
  tabs: {
    home: string;
    assistant: string;
    account: string;
  };
  /** Accessible name of the tab bar itself. */
  navLabel: string;
  /** Accessible name of the app bar. */
  barLabel: string;
  /** Shared chrome actions. */
  actions: {
    close: string;
    openAccount: string;
  };
}

const AR: AppShellCopy = {
  tabs: { home: "الرئيسية", assistant: "المساعد", account: "حسابي" },
  navLabel: "التنقل الرئيسي",
  barLabel: "شريط التطبيق",
  actions: { close: "إغلاق", openAccount: "فتح حسابي" },
};

const FR: AppShellCopy = {
  tabs: { home: "Accueil", assistant: "Assistant", account: "Profil" },
  navLabel: "Navigation principale",
  barLabel: "Barre de l'application",
  actions: { close: "Fermer", openAccount: "Ouvrir mon profil" },
};

export const APP_SHELL: Record<Lang, AppShellCopy> = { ar: AR, fr: FR };
