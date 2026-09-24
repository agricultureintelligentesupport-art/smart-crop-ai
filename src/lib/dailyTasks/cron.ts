/**
 * Cron endpoint auth — shared by both daily-workflow handlers.
 *
 * When `CRON_SECRET` is set (the Vercel convention), the scheduled calls must
 * present it as `Authorization: Bearer …` or a `?secret=` / `?token=` query
 * parameter. Unset secret = open handler (preview / self-hosted setups where
 * the scheduler is the only caller).
 */

export function cronAuthorized(authorizationHeader: string | null, query: URLSearchParams): boolean {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) return true;
  return (
    (authorizationHeader ?? "") === `Bearer ${secret}` ||
    query.get("secret") === secret ||
    query.get("token") === secret
  );
}
