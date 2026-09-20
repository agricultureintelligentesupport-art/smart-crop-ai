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
    <main
      className="screen-h relative mx-auto flex w-full max-w-[480px] flex-col items-center justify-center overflow-hidden px-6 font-arabic text-emerald-950"
      style={{ background: "linear-gradient(180deg, #F4FBF7 0%, #E6F7EF 55%, #DCF5E6 100%)" }}
    >
      {/* ambient backdrop — GPU-isolated so the blur stack rasterizes once */}
      <div aria-hidden className="pointer-events-none absolute inset-0 transform-gpu backface-hidden will-change-transform overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-white/60 via-transparent to-emerald-200/30" />
        <div className="absolute -end-20 -top-24 h-72 w-72 rounded-full bg-amber-300/40 blur-3xl" />
        <div className="absolute -start-24 -top-16 h-72 w-72 rounded-full bg-emerald-300/45 blur-3xl" />
        <div className="absolute -bottom-28 start-1/4 h-80 w-80 rounded-full bg-emerald-400/25 blur-3xl" />
      </div>

      <div className="glass relative z-10 flex w-full max-w-sm flex-col items-center gap-5 rounded-3xl p-8 text-center shadow-xl">
        <span className="grid h-16 w-16 place-items-center rounded-2xl bg-gradient-to-br from-emerald-400 via-emerald-500 to-emerald-700 text-white shadow-[0_14px_34px_-8px_rgba(16,185,129,0.65)]">
          {icon}
        </span>

        <div>
          <h1 className="text-xl font-black text-emerald-950">{titleAr}</h1>
          <p dir="ltr" className="mt-1 text-sm font-extrabold text-emerald-700">
            {titleFr}
          </p>
        </div>

        <p dir="rtl" className="text-[13px] font-semibold leading-7 text-emerald-900/75">
          {descAr}
        </p>
        <p dir="ltr" className="text-xs leading-5 text-emerald-800/70">
          {descFr}
        </p>

        <span className="glow-amber rounded-full border border-amber-300/50 bg-amber-100/80 px-3 py-1 text-[10px] font-black text-amber-800">
          قريبًا · Bientôt
        </span>

        <Link
          href="/"
          className="glow-emerald grid h-12 w-full place-items-center rounded-2xl bg-gradient-to-br from-emerald-500 to-green-600 text-[15px] font-black text-white transition-colors hover:from-emerald-400 hover:to-green-500"
        >
          رجوع · Retour
        </Link>
      </div>
    </main>
  );
}
