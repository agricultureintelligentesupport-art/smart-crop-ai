import { motion } from "framer-motion";

/* Slide 2 — Smart water drop with weather widget + irrigation scheduling card */

const DROP = "M160 52 C132 96 104 122 104 154 C104 186 129 206 160 206 C191 206 216 186 216 154 C216 122 188 96 160 52 Z";

const WAVE_TOP =
  "M -120 150 " +
  Array.from({ length: 14 }, () => "q 10 -7 20 0 t 20 0 ").join("") +
  " L 440 268 L -120 268 Z";

export default function IrrigationArt() {
  return (
    <svg viewBox="0 0 320 260" className="h-full w-full" fill="none" role="img" aria-label="Smart irrigation illustration">
      <defs>
        <linearGradient id="dropG" x1="116" y1="60" x2="206" y2="204" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#a5f3fc" />
          <stop offset="0.5" stopColor="#22d3ee" />
          <stop offset="1" stopColor="#0284c7" />
        </linearGradient>
        <radialGradient id="dropAuraG" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#22d3ee" stopOpacity="0.22" />
          <stop offset="1" stopColor="#22d3ee" stopOpacity="0" />
        </radialGradient>
        <clipPath id="dropClip">
          <path d={DROP} />
        </clipPath>
      </defs>

      <ellipse cx="160" cy="132" rx="140" ry="116" fill="url(#dropAuraG)" />

      {/* Orbiting gauge ring */}
      <motion.g
        style={{ transformBox: "fill-box", transformOrigin: "center" }}
        animate={{ rotate: -360 }}
        transition={{ duration: 44, ease: "linear", repeat: Infinity }}
      >
        <circle cx="160" cy="130" r="108" stroke="#0ea5e9" strokeOpacity="0.16" strokeWidth="1.5" strokeDasharray="2 9" />
      </motion.g>

      {/* The droplet */}
      <motion.g animate={{ y: [0, -6, 0] }} transition={{ duration: 5.5, ease: "easeInOut", repeat: Infinity }}>
        <path d={DROP} fill="url(#dropG)" stroke="rgba(255,255,255,0.5)" strokeWidth="1.5" />
        <g clipPath="url(#dropClip)">
          {/* Animated water surface */}
          <motion.g animate={{ x: [0, -40] }} transition={{ duration: 3, ease: "linear", repeat: Infinity }}>
            <path d={WAVE_TOP} fill="#22d3ee" fillOpacity="0.4" />
          </motion.g>
          {/* Shine */}
          <ellipse cx="134" cy="94" rx="9" ry="17" transform="rotate(-16 134 94)" fill="#ffffff" fillOpacity="0.5" />
          <circle cx="147" cy="72" r="3" fill="#ffffff" fillOpacity="0.65" />
          {/* Rising bubbles */}
          {[
            { cx: 148, r: 3.5, delay: 0 },
            { cx: 168, r: 2.6, delay: 1.1 },
            { cx: 156, r: 2, delay: 2 },
          ].map((b, i) => (
            <motion.circle
              key={i}
              cx={b.cx}
              r={b.r}
              fill="#e0faff"
              initial={{ cy: 198, opacity: 0 }}
              animate={{ cy: [198, 158], opacity: [0, 0.85, 0] }}
              transition={{ duration: 3.2, ease: "easeIn", repeat: Infinity, delay: b.delay }}
            />
          ))}
        </g>
        <text x="160" y="180" textAnchor="middle" fontSize="26" fontWeight="900" fill="#ffffff" opacity="0.95" fontFamily="inherit">
          68%
        </text>
        <text x="160" y="194" textAnchor="middle" fontSize="7.5" fontWeight="700" fill="#ecfeff" opacity="0.85" letterSpacing="1.5" fontFamily="inherit">
          H₂O NEED
        </text>
      </motion.g>

      {/* Ripple under the drop */}
      <motion.ellipse
        cx="160"
        cy="228"
        stroke="#22d3ee"
        strokeWidth="1.6"
        initial={{ rx: 30, ry: 4, opacity: 0.55 }}
        animate={{ rx: [30, 56], ry: [4, 9], opacity: [0.55, 0] }}
        transition={{ duration: 3, ease: "easeOut", repeat: Infinity }}
      />

      {/* Dashed data links */}
      <motion.path
        d="M116 88 Q 130 96 141 107"
        stroke="#0ea5e9"
        strokeOpacity="0.55"
        strokeWidth="1.6"
        strokeDasharray="3 5"
        animate={{ strokeDashoffset: [0, -32] }}
        transition={{ duration: 1.6, ease: "linear", repeat: Infinity }}
      />
      <motion.path
        d="M208 182 Q 194 174 181 168"
        stroke="#10b981"
        strokeOpacity="0.55"
        strokeWidth="1.6"
        strokeDasharray="3 5"
        animate={{ strokeDashoffset: [0, -32] }}
        transition={{ duration: 1.6, ease: "linear", repeat: Infinity, delay: 0.4 }}
      />

      {/* Weather widget card */}
      <g transform="translate(10 50)">
        <motion.g animate={{ y: [0, -5, 0] }} transition={{ duration: 6, ease: "easeInOut", repeat: Infinity, delay: 0.8 }}>
          <rect width="108" height="70" rx="16" fill="var(--art-surface)" stroke="var(--art-border)" />
          <circle cx="25" cy="22" r="6.5" fill="#f59e0b" />
          {Array.from({ length: 8 }, (_, i) => {
            const a = (i * Math.PI) / 4;
            return (
              <line
                key={i}
                x1={25 + Math.cos(a) * 9.5}
                y1={22 + Math.sin(a) * 9.5}
                x2={25 + Math.cos(a) * 12.5}
                y2={22 + Math.sin(a) * 12.5}
                stroke="#fbbf24"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            );
          })}
          <text x="44" y="27" fontSize="14.5" fontWeight="900" fill="var(--art-ink)" fontFamily="inherit">
            28°C
          </text>
          <line x1="12" y1="38" x2="96" y2="38" stroke="var(--art-border)" />
          <path d="M25 45 c -3.6 4.8 -5.4 6.9 -5.4 8.9 a 5.4 5.4 0 0 0 10.8 0 c 0 -2 -1.8 -4.1 -5.4 -8.9 Z" fill="#0ea5e9" />
          <text x="40" y="57" fontSize="9" fontWeight="700" fill="var(--art-ink-soft)" fontFamily="inherit">
            RH 41% · ET 4.2
          </text>
        </motion.g>
      </g>

      {/* Irrigation schedule card */}
      <g transform="translate(202 148)">
        <motion.g animate={{ y: [0, 5, 0] }} transition={{ duration: 6.5, ease: "easeInOut", repeat: Infinity, delay: 0.3 }}>
          <rect width="108" height="86" rx="16" fill="var(--art-surface)" stroke="var(--art-border)" />
          <circle cx="24" cy="20" r="8.5" stroke="#10b981" strokeWidth="1.8" />
          <path d="M24 15.5 L24 20 L27.5 22" stroke="#10b981" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          <text x="40" y="24.5" fontSize="11" fontWeight="900" fill="var(--art-ink)" fontFamily="inherit">
            06:00
          </text>
          <rect x="84" y="13" width="14" height="14" rx="4.5" fill="#10b981" />
          <path d="M87.5 20.2 l2.4 2.4 l4.6 -4.8" stroke="#ffffff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          <rect x="12" y="34" width="70" height="6" rx="3" fill="#34d399" />
          <rect x="12" y="45" width="46" height="6" rx="3" fill="#f59e0b" opacity="0.85" />
          <rect x="12" y="56" width="58" height="6" rx="3" fill="#38bdf8" opacity="0.85" />
          <text x="12" y="74.5" fontSize="7.5" fontWeight="800" fill="var(--art-ink-soft)" letterSpacing="0.5" fontFamily="inherit">
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
