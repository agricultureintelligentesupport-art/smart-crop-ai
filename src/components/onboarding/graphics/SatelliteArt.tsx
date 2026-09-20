import { motion } from "framer-motion";

/* Slide 3 — Satellite map interface with an NDVI crop-health heatmap */

const NDVI = [
  [0.55, 0.68, 0.78, 0.88, 0.9, 0.74, 0.5, 0.38],
  [0.66, 0.8, 0.92, 0.95, 0.86, 0.68, 0.46, 0.34],
  [0.72, 0.86, 0.94, 0.88, 0.76, 0.6, 0.42, 0.55],
  [0.6, 0.7, 0.84, 0.76, 0.64, 0.52, 0.66, 0.44],
  [0.48, 0.58, 0.68, 0.62, 0.54, 0.44, 0.58, 0.3],
];

function ndviColor(v: number) {
  if (v >= 0.85) return "#15803d";
  if (v >= 0.75) return "#22c55e";
  if (v >= 0.65) return "#84cc16";
  if (v >= 0.5) return "#eab308";
  if (v >= 0.4) return "#f59e0b";
  return "#ef4444";
}

const MAP = { x: 22, y: 54, w: 276, h: 178 };
const CELL = { w: 27, h: 23, gx: 4, gy: 4, x0: 48, y0: 76 };
const TARGET = { cx: CELL.x0 + 4 * (CELL.w + CELL.gx) + CELL.w / 2, cy: CELL.y0 + 1 * (CELL.h + CELL.gy) + CELL.h / 2 };

export default function SatelliteArt() {
  return (
    <svg viewBox="0 0 320 260" className="h-full w-full" fill="none" role="img" aria-label="Satellite NDVI map illustration">
      <defs>
        <radialGradient id="satAuraG" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#34d399" stopOpacity="0.2" />
          <stop offset="1" stopColor="#34d399" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="sweepG" x1="160" y1="0" x2="186" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#34d399" stopOpacity="0" />
          <stop offset="0.5" stopColor="#34d399" stopOpacity="0.3" />
          <stop offset="1" stopColor="#34d399" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="legendG" x1="52" y1="0" x2="142" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ef4444" />
          <stop offset="0.45" stopColor="#f59e0b" />
          <stop offset="0.72" stopColor="#a3e635" />
          <stop offset="1" stopColor="#15803d" />
        </linearGradient>
        <clipPath id="mapClip">
          <rect x={MAP.x} y={MAP.y} width={MAP.w} height={MAP.h} rx="20" />
        </clipPath>
      </defs>

      <ellipse cx="160" cy="132" rx="142" ry="116" fill="url(#satAuraG)" />

      {/* Map base */}
      <rect x={MAP.x} y={MAP.y} width={MAP.w} height={MAP.h} rx="20" fill="var(--art-map)" stroke="var(--art-border)" />

      <g clipPath="url(#mapClip)">
        {/* Graticule */}
        {[54, 86, 118, 150, 182, 214, 246, 278].map((x) => (
          <line key={`v${x}`} x1={x} y1={MAP.y} x2={x} y2={MAP.y + MAP.h} stroke="var(--art-map-line)" />
        ))}
        {[86, 118, 150, 182, 214].map((y) => (
          <line key={`h${y}`} x1={MAP.x} y1={y} x2={MAP.x + MAP.w} y2={y} stroke="var(--art-map-line)" />
        ))}

        {/* NDVI heatmap cells */}
        {NDVI.map((row, r) =>
          row.map((v, c) => (
            <motion.rect
              key={`${r}-${c}`}
              x={CELL.x0 + c * (CELL.w + CELL.gx)}
              y={CELL.y0 + r * (CELL.h + CELL.gy)}
              width={CELL.w}
              height={CELL.h}
              rx="4"
              fill={ndviColor(v)}
              animate={{ opacity: [0.62, 0.95, 0.62] }}
              transition={{ duration: 3.4, ease: "easeInOut", repeat: Infinity, delay: (r * 8 + c) * 0.09 }}
            />
          )),
        )}

        {/* Field boundary */}
        <motion.path
          d="M60 120 L150 84 L268 100 L244 200 L96 214 Z"
          stroke="#f59e0b"
          strokeWidth="1.6"
          strokeDasharray="5 6"
          animate={{ strokeDashoffset: [0, -44] }}
          transition={{ duration: 3.2, ease: "linear", repeat: Infinity }}
        />

        {/* Drifting clouds */}
        <motion.g animate={{ x: [-30, 70, -30] }} transition={{ duration: 26, ease: "easeInOut", repeat: Infinity }}>
          <ellipse cx="120" cy="70" rx="34" ry="9" fill="#94a3b8" opacity="0.14" />
          <ellipse cx="150" cy="62" rx="22" ry="7" fill="#94a3b8" opacity="0.1" />
          <ellipse cx="240" cy="205" rx="30" ry="8" fill="#94a3b8" opacity="0.1" />
        </motion.g>

        {/* Scan sweep */}
        <motion.g animate={{ x: [-130, 130] }} transition={{ duration: 5, ease: "easeInOut", repeat: Infinity, repeatType: "mirror" }}>
          <rect x="160" y={MAP.y} width="26" height={MAP.h} fill="url(#sweepG)" />
        </motion.g>

        {/* Legend */}
        <rect x="48" y="212" width="90" height="5" rx="2.5" fill="url(#legendG)" />
        <text x="48" y="227" fontSize="6.5" fontWeight="800" fill="var(--art-ink-soft)" letterSpacing="1" fontFamily="inherit">
          NDVI 0 — 1
        </text>
        <text x="288" y="226" textAnchor="end" fontSize="6.5" fontWeight="700" fill="var(--art-ink-soft)" fontFamily="inherit">
          BISKRA · 34.8N
        </text>
      </g>

      {/* HUD crosshair on the analyzed zone */}
      <g clipPath="url(#mapClip)">
        <motion.g
          style={{ transformBox: "fill-box", transformOrigin: "center" }}
          animate={{ rotate: 360 }}
          transition={{ duration: 14, ease: "linear", repeat: Infinity }}
        >
          <circle cx={TARGET.cx} cy={TARGET.cy} r="24" stroke="#10b981" strokeOpacity="0.8" strokeWidth="1.4" strokeDasharray="6 8" />
        </motion.g>
        <circle cx={TARGET.cx} cy={TARGET.cy} r="3" fill="#10b981" />
        <motion.circle
          cx={TARGET.cx}
          cy={TARGET.cy}
          stroke="#34d399"
          strokeWidth="1.6"
          initial={{ r: 4, opacity: 0.8 }}
          animate={{ r: [4, 26], opacity: [0.8, 0] }}
          transition={{ duration: 1.8, ease: "easeOut", repeat: Infinity }}
        />
        <text x={TARGET.cx} y={TARGET.cy + 36} textAnchor="middle" fontSize="8" fontWeight="900" fill="#10b981" fontFamily="inherit">
          0.94
        </text>
      </g>

      {/* Satellite */}
      <motion.g animate={{ y: [0, 5, 0], x: [0, -5, 0] }} transition={{ duration: 5.5, ease: "easeInOut", repeat: Infinity }}>
        <rect x="222" y="14" width="18" height="11" rx="2" fill="#0ea5e9" opacity="0.9" />
        <rect x="256" y="14" width="18" height="11" rx="2" fill="#0ea5e9" opacity="0.9" />
        {[228, 234, 240, 262, 268, 274].map((x) => (
          <line key={x} x1={x} y1="14" x2={x} y2="25" stroke="#e0f2fe" strokeWidth="0.8" opacity="0.7" />
        ))}
        <line x1="240" y1="19.5" x2="244" y2="19.5" stroke="#334155" strokeWidth="1.6" />
        <line x1="252" y1="19.5" x2="256" y2="19.5" stroke="#334155" strokeWidth="1.6" />
        <rect x="243" y="13.5" width="13" height="12.5" rx="3" fill="#334155" />
        <circle cx="249.5" cy="29.5" r="3" fill="#f59e0b" />
      </motion.g>

      {/* Downlink beam */}
      <motion.path
        d={`M249 33 L ${TARGET.cx + 2} ${TARGET.cy - 26}`}
        stroke="#34d399"
        strokeOpacity="0.75"
        strokeWidth="1.5"
        strokeDasharray="2 5"
        animate={{ strokeDashoffset: [0, -28] }}
        transition={{ duration: 1.1, ease: "linear", repeat: Infinity }}
      />

      {/* LIVE chip */}
      <g transform="translate(34 62)">
        <rect width="60" height="16" rx="8" fill="var(--art-surface)" stroke="var(--art-border)" />
        <motion.circle
          cx="10"
          cy="8"
          r="2.5"
          fill="#ef4444"
          animate={{ opacity: [1, 0.2, 1] }}
          transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
        />
        <text x="18" y="11.2" fontSize="7" fontWeight="900" fill="var(--art-ink)" letterSpacing="1" fontFamily="inherit">
          SAT-04
        </text>
      </g>
    </svg>
  );
}
