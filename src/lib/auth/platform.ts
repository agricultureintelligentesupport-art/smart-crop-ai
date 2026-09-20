/**
 * Lightweight client-environment detection for auth UX decisions.
 *
 * Dependency-free on purpose: it must stay importable from Node-based unit
 * tests (the repo's unit runner loads the app's TS directly).
 */

const MOBILE_UA =
  /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|Silk|CriOS|FxiOS/i;

/**
 * True on phones/tablets whose browsers block or botch OAuth popups
 * (popup blockers, mobile web views, in-app browsers).
 *
 * Those clients should use the full-page `signInWithRedirect` flow instead of
 * `signInWithPopup` — Google still shows its account chooser there, because
 * the shared provider carries `prompt: select_account`.
 */
export function isMobileBrowser(
  nav: Pick<Navigator, "userAgent"> | null | undefined =
    typeof navigator !== "undefined" ? navigator : null,
): boolean {
  const ua = nav?.userAgent;
  return typeof ua === "string" && MOBILE_UA.test(ua);
}
