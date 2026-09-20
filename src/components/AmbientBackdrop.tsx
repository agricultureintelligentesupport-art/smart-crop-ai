"use client";

import { memo } from "react";

/**
 * Ambient "sunrise over green fields" backdrop, shared by the onboarding
 * carousel, the auth flow and the dashboard.
 *
 * Memoized + GPU-isolated: the expensive blur-3xl glow stack rasterizes once
 * into its own composite layer and is never re-painted while panels animate
 * over it. `variant` only swaps the warm accent position so consecutive
 * screens do not look copy-pasted.
 */
const AmbientBackdrop = memo(function AmbientBackdrop({
  variant = "default",
}: {
  variant?: "default" | "auth" | "dashboard";
}) {
  const warmSide = variant === "auth" ? "start" : "end";
  const showTexture = variant !== "dashboard";

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-0 overflow-hidden transform-gpu backface-hidden will-change-transform"
    >
      {/* Soft directional light wash */}
      <div className="absolute inset-0 bg-gradient-to-b from-white/60 via-transparent to-emerald-200/30" />

      {/* Warm sunrise / sunshine glow */}
      <div
        className={`absolute -top-24 h-72 w-72 rounded-full bg-amber-300/40 blur-3xl ${
          warmSide === "end" ? "-end-20" : "-start-20"
        }`}
      />
      <div className={`absolute top-6 h-40 w-40 rounded-full bg-yellow-200/50 blur-2xl ${warmSide === "end" ? "end-4" : "start-4"}`} />

      {/* Vibrant fresh-sprout green glow */}
      <div className="absolute -start-24 -top-16 h-72 w-72 rounded-full bg-emerald-300/45 blur-3xl" />

      {/* Rich forest emerald pool */}
      <div className="absolute -bottom-28 start-1/4 h-80 w-80 rounded-full bg-emerald-400/25 blur-3xl" />

      {showTexture && (
        <div
          className="absolute inset-0 opacity-40"
          style={{
            backgroundImage: "radial-gradient(circle at 1px 1px, rgba(6,78,59,0.12) 1px, transparent 0)",
            backgroundSize: "26px 26px",
          }}
        />
      )}
    </div>
  );
});

export default AmbientBackdrop;
