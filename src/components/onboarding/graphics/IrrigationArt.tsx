import { memo } from "react";
import { motion } from "framer-motion";

/* Slide 2 — Smart water drop with weather widget + irrigation scheduling card */

const DROP = "M160 52 C132 96 104 122 104 154 C104 186 129 206 160 206 C191 206 216 186 216 154 C216 122 188 96 160 52 Z";

const WAVE_TOP =
  "M -120 150 " +
  Array.from({ length: 14 }, () => "q 10 -7 20 0 t 20 0 ").join("") +
  " L 440 268 L -120 268 Z";

function IrrigationArt() {
  return (
    <svg viewBox="0 0 320 260" className="h-full w-full" fill="none" role="img" aria-label="Smart irrigation illustration">
      <defs>
        {/* Fresh water-drop gradient (brightened) */}
        <linearGradient id="dropG" x1="116" y1="60" x2="206" y2="204" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#bae6fd" />
          <stop offset="0.45" stopColor="#38bdf8" />
          <stop offset="1" stopColor="#0284c7" />
        </linearGradient>
        {/* Dual-tone ambient halo: fresh sky-blue + emerald vitality */}
        <radialGradient id="dropAuraG" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#22d3ee" stopOpacity="0.4" />
          <stop offset="0.55" stopColor="#34d399" stopOpacity="0.25" />
          <stop offset="1" stopColor="#34d399" stopOpacity="0" />
        </radialGradient>
        {/* Warm sunshine halo */}
        <radialGradient id="sunHaloG" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#facc15" stopOpacity="0.5" />
          <stop offset="1" stopColor="#facc15" stopOpacity="0" />
        </radialGradient>
        <clipPath id="dropClip">
          <path d={DROP} />
        </clipPath>
        <filter id="cardShadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="6" stdDeviation="6" floodColor="#064e3b" floodOpacity="0.12" />
        </filter>
      </defs>

      {/* Ambient halos */}
      <ellipse cx="160" cy="132" rx="148" ry="122" fill="url(#dropAuraG)" />
      <ellipse cx="48" cy="72" rx="70" ry="60" fill="url(#sunHaloG)" />

      {/* Orbiting gauge ring (emerald tint) */}
      <motion.g
        style={{ transformBox: "fill-box", transformOrigin: "center", willChange: "transform" }}
        animate={{ rotate: -360 }}
        transition={{ duration: 44, ease: "linear", repeat: Infinity }}
      >
        <circle cx="160" cy="130" r="114" stroke="#10b981" strokeOpacity="0.22" strokeWidth="1.5" strokeDasharray="2 9" shapeRendering="geometricPrecision" />
      </motion.g>
      {/* Counter-ring with sky blue */}
      <motion.g
        style={{ transformBox: "fill-box", transformOrigin: "center", willChange: "transform" }}
        animate={{ rotate: 360 }}
        transition={{ duration: 60, ease: "linear", repeat: Infinity }}
      >
        <circle cx="160" cy="130" r="128" stroke="#0ea5e9" strokeOpacity="0.18" strokeWidth="1" strokeDasharray="3 13" shapeRendering="geometricPrecision" />
      </motion.g>

      {/* The droplet */}
      <motion.g
        style={{ willChange: "transform" }}
        animate={{ y: [0, -6, 0] }}
        transition={{ duration: 5.5, ease: "easeInOut", repeat: Infinity }}
      >
        <path d={DROP} fill="url(#dropG)" stroke="rgba(255,255,255,0.7)" strokeWidth="1.8" />
        <g clipPath="url(#dropClip)">
          {/* Animated water surface */}
          <motion.g
            style={{ willChange: "transform" }}
            animate={{ x: [0, -40] }}
            transition={{ duration: 3, ease: "linear", repeat: Infinity }}
          >
            <path d={WAVE_TOP} fill="#38bdf8" fillOpacity="0.45" shapeRendering="geometricPrecision" />
          </motion.g>
          {/* Shine */}
          <ellipse cx="134" cy="94" rx="9" ry="17" transform="rotate(-16 134 94)" fill="#ffffff" fillOpacity="0.65" />
          <circle cx="147" cy="72" r="3" fill="#ffffff" fillOpacity="0.8" />
          {/* Rising bubbles */}
          {[
            { cx: 148, r: 3.5, delay: 0 },
            { cx: 168, r: 2.6, delay: 1.1 },
            { cx: 156, r: 2, delay: 2 },
          ].map((b, i) => (
            <motion.circle
              key={i}
              cx={b.cx}
              cy={198}
              r={b.r}
              fill="#e0f2fe"
              shapeRendering="geometricPrecision"
              initial={{ y: 0, opacity: 0 }}
              animate={{ y: [0, -40], opacity: [0, 0.9, 0] }}
              transition={{ duration: 3.2, ease: "easeIn", repeat: Infinity, delay: b.delay }}
            />
          ))}
        </g>
        <text x="160" y="180" textAnchor="middle" fontSize="26" fontWeight="900" fill="#ffffff" opacity="0.98" fontFamily="inherit">
          68%
        </text>
        <text x="160" y="194" textAnchor="middle" fontSize="7.5" fontWeight="700" fill="#ecfeff" opacity="0.9" letterSpacing="1.5" fontFamily="inherit">
          H₂O NEED
        </text>
      </motion.g>

      {/* Ripple under the drop — emerald-tinted water */}
      <motion.ellipse
        cx="160"
        cy="228"
        stroke="#10b981"
        strokeWidth="1.8"
        shapeRendering="geometricPrecision"
        initial={{ rx: 30, ry: 4, opacity: 0.6 }}
        animate={{ rx: [30, 58], ry: [4, 9], opacity: [0.6, 0] }}
        transition={{ duration: 3, ease: "easeOut", repeat: Infinity }}
      />
      <motion.ellipse
        cx="160"
        cy="228"
        stroke="#38bdf8"
        strokeWidth="1.4"
        shapeRendering="geometricPrecision"
        initial={{ rx: 22, ry: 3, opacity: 0.5 }}
        animate={{ rx: [22, 50], ry: [3, 8], opacity: [0.5, 0] }}
        transition={{ duration: 3, ease: "easeOut", repeat: Infinity, delay: 0.8 }}
      />

      {/* Dashed data links */}
      <motion.path
        d="M116 88 Q 130 96 141 107"
        shapeRendering="geometricPrecision"
        stroke="#0ea5e9"
        strokeOpacity="0.6"
        strokeWidth="1.6"
        strokeDasharray="3 5"
        animate={{ strokeDashoffset: [0, -32] }}
        transition={{ duration: 1.6, ease: "linear", repeat: Infinity }}
      />
      <motion.path
        d="M208 182 Q 194 174 181 168"
        shapeRendering="geometricPrecision"
        stroke="#10b981"
        strokeOpacity="0.65"
        strokeWidth="1.6"
        strokeDasharray="3 5"
        animate={{ strokeDashoffset: [0, -32] }}
        transition={{ duration: 1.6, ease: "linear", repeat: Infinity, delay: 0.4 }}
      />

      {/* Weather widget card — light glass.
          GPU: the feDropShadow rasterizes once on a dedicated composite layer. */}
      <g filter="url(#cardShadow)" style={{ transform: "translate(10px, 50px) translateZ(0)", willChange: "transform" }}>
        <motion.g animate={{ y: [0, -5, 0] }} transition={{ duration: 6, ease: "easeInOut", repeat: Infinity, delay: 0.8 }}>
          <rect width="108" height="70" rx="16" fill="rgba(255,255,255,0.82)" stroke="#E2F1E8" />
          {/* Sun with glowing rays */}
          <circle cx="25" cy="22" r="7.5" fill="#f59e0b" />
          <circle cx="25" cy="22" r="10" fill="#facc15" fillOpacity="0.35" />
          {Array.from({ length: 8 }, (_, i) => {
            const a = (i * Math.PI) / 4;
            return (
              <line
                key={i}
                x1={25 + Math.cos(a) * 11}
                y1={22 + Math.sin(a) * 11}
                x2={25 + Math.cos(a) * 14.5}
                y2={22 + Math.sin(a) * 14.5}
                stroke="#f59e0b"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            );
          })}
          <text x="48" y="27" fontSize="14.5" fontWeight="900" fill="#064e3b" fontFamily="inherit">
            28°C
          </text>
          <line x1="12" y1="38" x2="96" y2="38" stroke="#E2F1E8" />
          <path d="M25 45 c -3.6 4.8 -5.4 6.9 -5.4 8.9 a 5.4 5.4 0 0 0 10.8 0 c 0 -2 -1.8 -4.1 -5.4 -8.9 Z" fill="#0ea5e9" />
          <text x="40" y="57" fontSize="9" fontWeight="700" fill="#0f766e" fontFamily="inherit">
            RH 41% · ET 4.2
          </text>
        </motion.g>
      </g>

      {/* Irrigation schedule card — GPU-isolated filter layer. */}
      <g filter="url(#cardShadow)" style={{ transform: "translate(202px, 148px) translateZ(0)", willChange: "transform" }}>
        <motion.g animate={{ y: [0, 5, 0] }} transition={{ duration: 6.5, ease: "easeInOut", repeat: Infinity, delay: 0.3 }}>
          <rect width="108" height="86" rx="16" fill="rgba(255,255,255,0.82)" stroke="#E2F1E8" />
          <circle cx="24" cy="20" r="8.5" stroke="#10b981" strokeWidth="2" />
          <path d="M24 15.5 L24 20 L27.5 22" stroke="#10b981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <text x="40" y="24.5" fontSize="11" fontWeight="900" fill="#064e3b" fontFamily="inherit">
            06:00
          </text>
          <rect x="84" y="13" width="14" height="14" rx="4.5" fill="#22c55e" />
          <path d="M87.5 20.2 l2.4 2.4 l4.6 -4.8" stroke="#ffffff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          {/* Progress bars */}
          <rect x="12" y="34" width="70" height="6" rx="3" fill="#d1fae5" />
          <rect x="12" y="34" width="70" height="6" rx="3" fill="#22c55e" />
          <rect x="12" y="45" width="46" height="6" rx="3" fill="#fef3c7" />
          <rect x="12" y="45" width="46" height="6" rx="3" fill="#f59e0b" />
          <rect x="12" y="56" width="58" height="6" rx="3" fill="#e0f2fe" />
          <rect x="12" y="56" width="58" height="6" rx="3" fill="#38bdf8" />
          <text x="12" y="74.5" fontSize="7.5" fontWeight="800" fill="#0f766e" letterSpacing="0.5" fontFamily="inherit">
            WATER SAVED
          </text>
          <text x="96" y="74.5" textAnchor="end" fontSize="9" fontWeight="900" fill="#059669" fontFamily="inherit">
            −32%
          </text>
        </motion.g>
      </g>
    </svg>
  );
}

/* React.memo: static artwork — never re-renders when the slide/text state changes. */
export default memo(IrrigationArt);
