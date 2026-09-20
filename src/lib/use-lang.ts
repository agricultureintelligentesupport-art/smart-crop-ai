"use client";

import { useCallback, useEffect, useState } from "react";
import type { Lang } from "./wilayas";

const LANG_KEY = "smart-crop.lang.v1";

export function readStoredLang(): Lang | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LANG_KEY);
    return raw === "ar" || raw === "fr" ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Initial value resolution.
 *
 * The server always renders `initial` so the HTML matches; on the client the
 * stored preference is read *during* the first render instead of in an effect,
 * which avoids a second synchronous render pass. `<html>` is already correct
 * because the server defaults to Arabic (`dir="rtl"` in `app/layout.tsx`), and
 * every screen re-applies its own `dir` attribute from state.
 */
function resolveInitialLang(initial: Lang): Lang {
  return readStoredLang() ?? initial;
}

/** App-wide language state: persisted, SSR-safe, keeps <html> in sync. */
export function useLang(initial: Lang = "ar") {
  const [lang, setLangState] = useState<Lang>(() => resolveInitialLang(initial));
  const dir: "rtl" | "ltr" = lang === "ar" ? "rtl" : "ltr";

  // External system sync (document element), not React state: allowed in an effect.
  useEffect(() => {
    const el = document.documentElement;
    el.lang = lang;
    el.dir = lang === "ar" ? "rtl" : "ltr";
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      window.localStorage.setItem(LANG_KEY, next);
    } catch {
      /* private mode */
    }
  }, []);

  return { lang, setLang, dir };
}
