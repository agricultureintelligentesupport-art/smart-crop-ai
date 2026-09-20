import Link from "next/link";

/**
 * Bilingual placeholder shown after the pre-auth flow ends
 * (registration form / guest dashboard land in the next milestone).
 */
export default function NextStep({
  icon,
  titleAr,
  titleFr,
  descAr,
  descFr,
}: {
  icon: React.ReactNode;
  titleAr: string;
  titleFr: string;
  descAr: string;
  descFr: string;
}) {
  return (
    <main className="screen-h relative mx-auto flex w-full max-w-[480px] flex-col items-center justify-center overflow-hidden bg-slate-50 px-6 font-arabic text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      {/* ambient backdrop */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-gradient-to-b from-emerald-100/70 via-transparent to-amber-100/60 dark:from-emerald-500/[0.06] dark:to-amber-500/[0.05]" />
        <div className="absolute -start-24 -top-24 h-72 w-72 rounded-full bg-emerald-400/25 blur-3xl dark:bg-emerald-500/15" />
        <div className="absolute -bottom-24 -end-24 h-72 w-72 rounded-full bg-amber-300/30 blur-3xl dark:bg-amber-400/10" />
      </div>

      <div className="glass relative z-10 flex w-full max-w-sm flex-col items-center gap-5 rounded-3xl p-8 text-center shadow-xl">
        <span className="grid h-16 w-16 place-items-center rounded-2xl bg-gradient-to-br from-emerald-400 via-emerald-500 to-emerald-700 text-white shadow-[0_12px_30px_-8px_rgba(16,185,129,0.65)]">
          {icon}
        </span>

        <div>
          <h1 className="text-xl font-black">{titleAr}</h1>
          <p dir="ltr" className="mt-1 text-sm font-extrabold text-emerald-700 dark:text-emerald-300">
            {titleFr}
          </p>
        </div>

        <p dir="rtl" className="text-[13px] font-semibold leading-7 text-slate-600 dark:text-slate-300/85">
          {descAr}
        </p>
        <p dir="ltr" className="text-xs leading-5 text-slate-500 dark:text-slate-400">
          {descFr}
        </p>

        <span className="rounded-full border border-amber-500/30 bg-amber-400/15 px-3 py-1 text-[10px] font-black text-amber-600 dark:text-amber-300">
          قريبًا · Bientôt
        </span>

        <Link
          href="/"
          className="grid h-12 w-full place-items-center rounded-2xl bg-emerald-500 text-[15px] font-black text-white shadow-[0_14px_30px_-10px_rgba(16,185,129,0.7)] transition-colors hover:bg-emerald-400"
        >
          رجوع · Retour
        </Link>
      </div>
    </main>
  );
}
