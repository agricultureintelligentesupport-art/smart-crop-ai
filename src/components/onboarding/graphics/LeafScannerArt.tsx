import { motion } from "framer-motion";

/* Slide 1 — High-tech glowing leaf scanner with a camera viewfinder frame */

const FRAME = { x: 70, y: 44, w: 180, h: 170 };

type Corner = [cx: number, cy: number, sx: 1 | -1, sy: 1 | -1];
const CORNERS: Corner[] = [
  [FRAME.x, FRAME.y, 1, 1],
  [FRAME.x + FRAME.w, FRAME.y, -1, 1],
  [FRAME.x, FRAME.y + FRAME.h, 1, -1],
  [FRAME.x + FRAME.w, FRAME.y + FRAME.h, -1, -1],
];

function bracket([cx, cy, sx, sy]: Corner) {
  return `M ${cx + 26 * sx} ${cy} L ${cx + 8 * sx} ${cy} Q ${cx} ${cy} ${cx} ${cy + 8 * sy} L ${cx} ${cy + 26 * sy}`;
}

export default function LeafScannerArt() {
  return (
    <svg viewBox="0 0 320 260" className="h-full w-full" fill="none" role="img" aria-label="Leaf scanner illustration">
      <defs>
        <linearGradient id="leafG" x1="100" y1="66" x2="222" y2="200" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#6ee7b7" />
          <stop offset="0.55" stopColor="#10b981" />
          <stop offset="1" stopColor="#047857" />
        </linearGradient>
        <linearGradient id="scanG" x1="160" y1="108" x2="160" y2="150" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#34d399" stopOpacity="0" />
          <stop offset="1" stopColor="#34d399" stopOpacity="0.4" />
        </linearGradient>
        <radialGradient id="scanAuraG" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#34d399" stopOpacity="0.28" />
          <stop offset="1" stopColor="#34d399" stopOpacity="0" />
        </radialGradient>
        <clipPath id="scanFrameClip">
          <rect x={FRAME.x} y={FRAME.y} width={FRAME.w} height={FRAME.h} rx="26" />
        </clipPath>
      </defs>

      {/* Ambient glow + slowly rotating tech ring */}
      <ellipse cx="160" cy="130" rx="140" ry="118" fill="url(#scanAuraG)" />
      <motion.g
        style={{ transformBox: "fill-box", transformOrigin: "center" }}
        animate={{ rotate: 360 }}
        transition={{ duration: 36, ease: "linear", repeat: Infinity }}
      >
        <circle cx="160" cy="129" r="112" stroke="#10b981" strokeOpacity="0.18" strokeWidth="1.5" strokeDasharray="3 10" />
      </motion.g>

      {/* Viewfinder frame */}
      <rect x={FRAME.x} y={FRAME.y} width={FRAME.w} height={FRAME.h} rx="26" fill="var(--art-surface-soft)" stroke="var(--art-border)" />

      <g clipPath="url(#scanFrameClip)">
        {/* Faint grid inside the lens */}
        {[82, 114, 146, 178, 210, 242].map((x) => (
          <line key={`v${x}`} x1={x} y1={FRAME.y} x2={x} y2={FRAME.y + FRAME.h} stroke="#10b981" strokeOpacity="0.05" />
        ))}
        {[70, 100, 130, 160, 190, 220].map((y) => (
          <line key={`h${y}`} x1={FRAME.x} y1={y} x2={FRAME.x + FRAME.w} y2={y} stroke="#10b981" strokeOpacity="0.05" />
        ))}

        {/* Leaf */}
        <g>
          <motion.g
            style={{ transformBox: "fill-box", transformOrigin: "center" }}
            animate={{ rotate: [-2.5, 2.5, -2.5] }}
            transition={{ duration: 6, ease: "easeInOut", repeat: Infinity }}
          >
            <path d="M160 66 C214 92 226 164 160 196 C94 164 106 92 160 66 Z" fill="url(#leafG)" />
            <path d="M160 74 L160 190" stroke="#ecfdf5" strokeOpacity="0.65" strokeWidth="2.4" strokeLinecap="round" />
            <path
              d="M160 100 C176 108 188 120 193 136 M160 100 C144 108 132 120 127 136 M160 134 C175 142 185 152 189 166 M160 134 C145 142 135 152 131 166"
              stroke="#ecfdf5"
              strokeOpacity="0.4"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
            <path d="M160 196 C160 205 158 211 152 217" stroke="#047857" strokeWidth="3" strokeLinecap="round" />
          </motion.g>

          {/* Disease hotspots with pulsing rings */}
          <motion.circle cx="186" cy="118" r="6.5" fill="#f59e0b" />
          <motion.circle
            cx="186"
            cy="118"
            stroke="#fbbf24"
            strokeWidth="2"
            initial={{ r: 7, opacity: 0.8 }}
            animate={{ r: [7, 18], opacity: [0.8, 0] }}
            transition={{ duration: 1.8, ease: "easeOut", repeat: Infinity }}
          />
          <motion.circle cx="138" cy="146" r="4.5" fill="#f59e0b" fillOpacity="0.9" />
          <motion.circle
            cx="138"
            cy="146"
            stroke="#fbbf24"
            strokeWidth="1.6"
            initial={{ r: 5, opacity: 0.7 }}
            animate={{ r: [5, 14], opacity: [0.7, 0] }}
            transition={{ duration: 1.8, ease: "easeOut", repeat: Infinity, delay: 0.6 }}
          />
        </g>

        {/* Sweeping scan line */}
        <motion.g animate={{ y: [-64, 66] }} transition={{ duration: 2.4, ease: "easeInOut", repeat: Infinity, repeatType: "mirror" }}>
          <rect x="70" y="108" width="180" height="42" fill="url(#scanG)" />
          <line x1="76" y1="150" x2="244" y2="150" stroke="#34d399" strokeWidth="2" strokeLinecap="round" opacity="0.9" />
        </motion.g>
      </g>

      {/* Corner brackets */}
      {CORNERS.map((c, i) => (
        <path key={i} d={bracket(c)} stroke="#10b981" strokeWidth="3.5" strokeLinecap="round" />
      ))}

      {/* Blinking REC-style marker */}
      <motion.circle
        cx="88"
        cy="62"
        r="3"
        fill="#10b981"
        animate={{ opacity: [1, 0.15, 1] }}
        transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
      />
      <text x="97" y="65.5" fontSize="8" fontWeight="800" fill="var(--art-ink-soft)" letterSpacing="1.5" fontFamily="inherit">
        SCAN
      </text>

      {/* Result chip */}
      <g>
        <rect x="100" y="174" width="120" height="26" rx="13" fill="var(--art-surface)" stroke="var(--art-border)" />
        <circle cx="115" cy="187" r="4" fill="#f59e0b" />
        <text x="126" y="190.5" fontSize="9.5" fontWeight="800" fill="var(--art-ink)" fontFamily="inherit">
          MATCH 98% · 0.4s
        </text>
      </g>

      {/* Floating HUD chips */}
      <motion.g animate={{ y: [0, -5, 0] }} transition={{ duration: 4.4, ease: "easeInOut", repeat: Infinity }}>
        <rect x="238" y="8" width="62" height="24" rx="12" fill="var(--art-surface)" stroke="var(--art-border)" />
        <text x="269" y="23.5" textAnchor="middle" fontSize="10" fontWeight="900" fill="#059669" fontFamily="inherit">
          AI ✓
        </text>
      </motion.g>
      <motion.g animate={{ y: [0, 6, 0] }} transition={{ duration: 5, ease: "easeInOut", repeat: Infinity, delay: 0.6 }}>
        <rect x="10" y="202" width="92" height="24" rx="12" fill="var(--art-surface)" stroke="var(--art-border)" />
        <text x="56" y="217.5" textAnchor="middle" fontSize="9" fontWeight="800" fill="var(--art-ink-soft)" fontFamily="inherit">
          234 PATHS
        </text>
      </motion.g>
    </svg>
  );
}
