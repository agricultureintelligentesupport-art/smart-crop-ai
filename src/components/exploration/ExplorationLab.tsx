"use client";

import {
  ArrowDownRight,
  ArrowRight,
  Check,
  Droplets,
  Eye,
  Layers3,
  Leaf,
  Move3d,
  Orbit,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

type DirectionId = "atlas" | "canopy" | "waterline";

type Direction = {
  id: DirectionId;
  letter: string;
  name: string;
  descriptor: string;
  oneLine: string;
  difference: string;
  depth: string;
  motion: string;
  color: string;
};

const DIRECTIONS: Direction[] = [
  {
    id: "atlas",
    letter: "A",
    name: "Field Atlas",
    descriptor: "Measured, grounded, quietly editorial",
    oneLine: "Turn the farm into a readable field notebook.",
    difference:
      "This is the most composed and trustworthy option: less dashboard, more instrument panel for a real place.",
    depth:
      "Depth comes from stacked paper-like planes, a lifted parcel map, contour lines, and a soft olive shadow under the survey card.",
    motion:
      "A thin route line draws itself across the parcel, the zone beacon breathes, and the contour rings drift at different speeds.",
    color: "olive",
  },
  {
    id: "canopy",
    letter: "B",
    name: "Living Canopy",
    descriptor: "Cinematic, high-signal, biologically alive",
    oneLine: "Make plant health feel like a living system you can read.",
    difference:
      "This has the strongest premium-tech energy: focused, dramatic, and designed to make diagnosis feel immediate.",
    depth:
      "Depth comes from the dark atmospheric field, a large layered leaf, rotating rings, luminous data arcs, and translucent telemetry floating above it.",
    motion:
      "The canopy expands and contracts like a slow breath, an orbit marker circles the leaf, and a vertical scan beam sweeps through the signal.",
    color: "canopy",
  },
  {
    id: "waterline",
    letter: "C",
    name: "Waterline",
    descriptor: "Tactile, optimistic, action-first",
    oneLine: "Make the next watering decision feel tangible.",
    difference:
      "This is the friendliest and most immediate direction: brighter, softer, and built around progress you can feel in your hands.",
    depth:
      "Depth comes from overlapping water surfaces, a raised horizon, translucent droplets, field furrows, and a warm sun disc behind the flow.",
    motion:
      "The irrigation stream travels left to right, droplets fall into the lower channel, and the water level rises and settles in a gentle tide.",
    color: "waterline",
  },
];

export default function ExplorationLab() {
  const [activeId, setActiveId] = useState<DirectionId>("atlas");
  const active = useMemo(() => DIRECTIONS.find((direction) => direction.id === activeId) ?? DIRECTIONS[0], [activeId]);

  return (
    <div className="lab-shell" dir="ltr">
      <header className="lab-header">
        <Link className="lab-brand" href="/" aria-label="Back to Smart Crop AI home">
          <span className="lab-brand-mark" aria-hidden="true">
            <Leaf size={17} strokeWidth={2.6} />
          </span>
          <span>
            <strong>SMART CROP AI</strong>
            <small>exploration lab</small>
          </span>
        </Link>

        <div className="lab-header-meta">
          <span className="lab-status-dot" aria-hidden="true" />
          <span>3 live directions</span>
          <a href="#directions">Jump to comparison</a>
        </div>
      </header>

      <main className="lab-main">
        <section className="lab-intro" aria-labelledby="lab-title">
          <div className="lab-intro-copy">
            <p className="lab-eyebrow"><span>01</span> Visual direction study</p>
            <h1 id="lab-title">Three ways to make the field legible.</h1>
            <p className="lab-lede">
              Each direction uses the same crop intelligence, but gives it a different physical world: a survey notebook, a living canopy, or a moving waterline.
            </p>
          </div>
          <div className="lab-intro-note">
            <span className="lab-note-icon"><Eye size={17} /></span>
            <p><strong>Look for the feeling.</strong> The small motion and layered surfaces are intentional. Click any direction to bring it forward.</p>
          </div>
        </section>

        <section className={`lab-workbench lab-workbench-${active.color}`} aria-labelledby="active-title">
          <div className="lab-stage-column">
            <div className="lab-stage-heading">
              <div>
                <p className="lab-eyebrow"><span>Selected</span> Direction {active.letter}</p>
                <h2 id="active-title">{active.name}</h2>
              </div>
              <div className="lab-stage-counter" aria-label={`Showing direction ${active.letter} of 3`}>
                <span className="lab-counter-active">{active.letter}</span><span>/</span><span>03</span>
              </div>
            </div>
            <div className="lab-active-scene">
              <DirectionScene id={active.id} />
              <div className="lab-scene-caption">
                <span>{active.descriptor}</span>
                <span className="lab-live-label"><span className="lab-status-dot" aria-hidden="true" /> live motion</span>
              </div>
            </div>
          </div>

          <aside className="lab-inspector" aria-label={`Direction ${active.letter} notes`}>
            <div className="lab-inspector-top">
              <span className="lab-direction-badge">{active.letter}</span>
              <div>
                <p className="lab-eyebrow">The core idea</p>
                <h3>{active.oneLine}</h3>
              </div>
            </div>

            <div className="lab-inspector-list">
              <InfoRow icon={<Layers3 size={16} />} label="What you see" text={compositionFor(active.id)} />
              <InfoRow icon={<Move3d size={16} />} label="Where depth comes from" text={active.depth} />
              <InfoRow icon={<Orbit size={16} />} label="What moves" text={active.motion} />
            </div>

            <div className="lab-feel-callout">
              <span>How it differs</span>
              <p>{active.difference}</p>
            </div>
          </aside>
        </section>

        <section id="directions" className="lab-directions" aria-labelledby="directions-title">
          <div className="lab-section-heading">
            <div>
              <p className="lab-eyebrow"><span>Compare</span> All three remain live</p>
              <h2 id="directions-title">Choose the world the product should inhabit.</h2>
            </div>
            <p>Tap a thumbnail to inspect it at full size.</p>
          </div>

          <div className="lab-direction-grid" role="tablist" aria-label="Visual directions">
            {DIRECTIONS.map((direction) => {
              const isActive = direction.id === activeId;
              return (
                <button
                  key={direction.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  aria-controls="active-title"
                  className={`lab-direction-option ${isActive ? "is-active" : ""} lab-option-${direction.color}`}
                  onClick={() => setActiveId(direction.id)}
                >
                  <div className="lab-option-scene">
                    <DirectionScene id={direction.id} compact />
                    {isActive && <span className="lab-option-selected"><Check size={13} /> selected</span>}
                  </div>
                  <div className="lab-option-copy">
                    <span className="lab-option-letter">{direction.letter}</span>
                    <span>
                      <strong>{direction.name}</strong>
                      <small>{direction.descriptor}</small>
                    </span>
                    <ArrowRight className="lab-option-arrow" size={18} />
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        <section className="lab-shared-thread" aria-label="Shared product thread">
          <div className="lab-thread-label"><Sparkles size={16} /> Shared thread</div>
          <div className="lab-thread-line" aria-hidden="true" />
          <p>Same underlying signals, different emotional entry point. Every option can still hold scan, irrigation, satellite, and daily decision support.</p>
          <a href="#lab-title">Back to the top <ArrowDownRight size={15} /></a>
        </section>
      </main>

      <footer className="lab-footer">
        <span>SMART CROP AI / product direction study</span>
        <span>Built for comparison, not commitment.</span>
      </footer>
    </div>
  );
}

function InfoRow({ icon, label, text }: { icon: React.ReactNode; label: string; text: string }) {
  return (
    <div className="lab-info-row">
      <span className="lab-info-icon" aria-hidden="true">{icon}</span>
      <div><span>{label}</span><p>{text}</p></div>
    </div>
  );
}

function compositionFor(id: DirectionId) {
  if (id === "atlas") {
    return "A pale survey board fills the frame. The parcel sits in the middle as a tilted top-down map, with a small timestamp above it and compact decision readouts tucked around its edges.";
  }
  if (id === "canopy") {
    return "A deep green field holds one oversized leaf-like canopy. A bright core anchors the center while rings, arcs, and small telemetry cards orbit around it like a living diagnostic instrument.";
  }
  return "A warm cream horizon cuts across the scene. The main water channel rises from the lower left toward a crop strip on the right, with the recommendation floating above the moving surface.";
}

function DirectionScene({ id, compact = false }: { id: DirectionId; compact?: boolean }) {
  if (id === "atlas") return <AtlasScene compact={compact} />;
  if (id === "canopy") return <CanopyScene compact={compact} />;
  return <WaterlineScene compact={compact} />;
}

function AtlasScene({ compact }: { compact: boolean }) {
  const suffix = compact ? "mini" : "main";
  return (
    <div className="scene scene-atlas" role="img" aria-label="Field Atlas preview: a top-down parcel map with contour layers and a moving route line">
      <div className="scene-noise" />
      <div className="atlas-topline"><span>FIELD ATLAS</span><span>ZONE 04 / 07:40</span></div>
      <div className="atlas-coordinate atlas-coordinate-one">34°51&apos;N</div>
      <div className="atlas-coordinate atlas-coordinate-two">5°43&apos;E</div>
      <div className="atlas-halo atlas-halo-one" />
      <div className="atlas-halo atlas-halo-two" />
      <div className="atlas-map-wrap">
        <div className="atlas-map-label"><span className="atlas-label-dot" /> plot 04 / wheat</div>
        <svg className="atlas-map" viewBox="0 0 620 380" fill="none" aria-hidden="true">
          <defs>
            <linearGradient id={`atlas-ground-${suffix}`} x1="70" y1="40" x2="540" y2="340" gradientUnits="userSpaceOnUse">
              <stop stopColor="#f3e7c8" />
              <stop offset="1" stopColor="#d5d8a7" />
            </linearGradient>
            <linearGradient id={`atlas-glow-${suffix}`} x1="0" y1="0" x2="1" y2="1">
              <stop stopColor="#fff7d8" stopOpacity="0.8" />
              <stop offset="1" stopColor="#a6b978" stopOpacity="0.15" />
            </linearGradient>
            <filter id={`atlas-shadow-${suffix}`} x="-30%" y="-30%" width="160%" height="170%">
              <feDropShadow dx="0" dy="18" stdDeviation="16" floodColor="#5d6d3d" floodOpacity="0.22" />
            </filter>
          </defs>
          <path d="M98 72 L500 42 L560 260 L130 330 Z" fill="#a3ad72" opacity="0.22" filter={`url(#atlas-shadow-${suffix})`} />
          <path d="M74 56 L478 28 L548 246 L112 310 Z" fill={`url(#atlas-ground-${suffix})`} stroke="#6d7f4b" strokeOpacity="0.48" strokeWidth="2" />
          <path d="M96 79 L466 54 L520 227 L133 283 Z" fill={`url(#atlas-glow-${suffix})`} opacity="0.75" />
          <g className="atlas-row-lines" opacity="0.42">
            <path d="M112 92 L480 66" /><path d="M118 113 L487 87" /><path d="M124 134 L494 108" /><path d="M130 155 L500 129" /><path d="M136 176 L506 150" /><path d="M142 197 L512 171" /><path d="M148 218 L518 192" /><path d="M154 239 L524 213" /><path d="M160 260 L530 234" />
          </g>
          <g className="atlas-contours" fill="none" stroke="#7d8b56" strokeWidth="2">
            <path d="M111 119 C190 55 318 69 389 91 C443 108 470 96 523 70" />
            <path d="M118 143 C196 82 304 91 381 111 C444 128 481 121 526 100" />
            <path d="M124 168 C197 112 306 116 379 135 C438 151 482 149 530 132" />
            <path d="M130 194 C206 142 310 143 374 161 C432 177 479 176 534 160" />
            <path d="M136 220 C218 172 312 172 367 188 C423 204 479 204 538 189" />
            <path d="M143 247 C224 205 307 201 361 215 C418 231 480 232 542 217" />
          </g>
          <path className="atlas-route" d="M126 266 C198 223 224 123 310 112 C381 103 383 205 456 192 C493 186 499 151 516 112" stroke="#d88742" strokeWidth="4" strokeLinecap="round" strokeDasharray="10 11" />
          <circle className="atlas-beacon" cx="310" cy="112" r="7" fill="#f5b35f" />
          <circle className="atlas-beacon-ring" cx="310" cy="112" r="20" stroke="#d88742" strokeWidth="2" />
          <g className="atlas-north" transform="translate(518 56)">
            <path d="M0 26 L9 0 L18 26 L9 20 Z" fill="#516743" /><path d="M9 0 L9 38" stroke="#516743" strokeWidth="2" /><text x="9" y="51" textAnchor="middle" fill="#516743" fontSize="13" fontWeight="700">N</text>
          </g>
        </svg>
        <div className="atlas-zone-card">
          <span>decision zone</span><strong>water soon</strong><small>14% below field baseline</small>
        </div>
      </div>
      <div className="atlas-data-stack">
        <div><span>SOIL MOISTURE</span><strong>41<span>%</span></strong></div>
        <div><span>ET₀ / TODAY</span><strong>5.0<span>mm</span></strong></div>
      </div>
      <div className="atlas-bottom-rule"><span>TRACE / ADVISE / ACT</span><i /><span>SMART CROP AI</span></div>
    </div>
  );
}

function CanopyScene({ compact }: { compact: boolean }) {
  const suffix = compact ? "mini" : "main";
  return (
    <div className="scene scene-canopy" role="img" aria-label="Living Canopy preview: an illuminated leaf system with orbiting diagnostic signals">
      <div className="canopy-stars" />
      <div className="canopy-topline"><span>CANOPY / LIVE DIAGNOSTIC</span><span>98.4%</span></div>
      <div className="canopy-scan-beam" />
      <div className="canopy-orbit canopy-orbit-outer"><span /></div>
      <div className="canopy-orbit canopy-orbit-inner"><span /><i /></div>
      <div className="canopy-core-glow" />
      <svg className="canopy-art" viewBox="0 0 560 420" fill="none" aria-hidden="true">
        <defs>
          <radialGradient id={`canopy-core-${suffix}`} cx="50%" cy="44%" r="58%">
            <stop stopColor="#d9ffad" stopOpacity="0.96" />
            <stop offset="0.24" stopColor="#73d58f" stopOpacity="0.95" />
            <stop offset="0.65" stopColor="#18836b" stopOpacity="0.88" />
            <stop offset="1" stopColor="#064a47" stopOpacity="0" />
          </radialGradient>
          <linearGradient id={`canopy-leaf-${suffix}`} x1="180" y1="38" x2="392" y2="365" gradientUnits="userSpaceOnUse">
            <stop stopColor="#d7ff9e" /><stop offset="0.35" stopColor="#62ca7e" /><stop offset="1" stopColor="#075752" />
          </linearGradient>
          <filter id={`canopy-shadow-${suffix}`} x="-40%" y="-30%" width="180%" height="180%">
            <feDropShadow dx="0" dy="22" stdDeviation="19" floodColor="#000" floodOpacity="0.42" />
          </filter>
        </defs>
        <ellipse cx="280" cy="210" rx="193" ry="166" fill={`url(#canopy-core-${suffix})`} opacity="0.66" />
        <path d="M279 365 C274 296 265 240 227 187 C194 141 151 105 128 50 C207 42 294 71 337 126 C380 181 371 271 279 365Z" fill={`url(#canopy-leaf-${suffix})`} filter={`url(#canopy-shadow-${suffix})`} />
        <path d="M280 359 C276 265 254 166 147 66" stroke="#dbffae" strokeOpacity="0.8" strokeWidth="3" strokeLinecap="round" />
        <path d="M270 271 C231 236 187 216 152 203" stroke="#e8ffbf" strokeOpacity="0.56" strokeWidth="2" />
        <path d="M258 223 C225 185 194 159 166 147" stroke="#e8ffbf" strokeOpacity="0.48" strokeWidth="2" />
        <path d="M291 302 C325 258 349 223 355 181" stroke="#0a665e" strokeOpacity="0.72" strokeWidth="2" />
        <path d="M279 278 C318 275 350 264 376 240" stroke="#0a665e" strokeOpacity="0.64" strokeWidth="2" />
        <path d="M274 183 C304 161 326 139 341 109" stroke="#0a665e" strokeOpacity="0.5" strokeWidth="2" />
        <g className="canopy-points">
          <circle cx="195" cy="119" r="4" fill="#ecffb7" /><circle cx="235" cy="181" r="4" fill="#ecffb7" /><circle cx="318" cy="152" r="4" fill="#ecffb7" /><circle cx="335" cy="243" r="4" fill="#ecffb7" /><circle cx="244" cy="281" r="4" fill="#ecffb7" />
        </g>
        <path className="canopy-signal-path" d="M86 329 C164 280 179 244 211 199 C249 146 300 119 360 124 C414 129 450 158 484 104" stroke="#8ef5a1" strokeWidth="2" strokeDasharray="5 10" />
        <circle className="canopy-signal-dot" cx="484" cy="104" r="7" fill="#d6ff8a" />
      </svg>
      <div className="canopy-readout canopy-readout-left"><span>leaf vitality</span><strong>0.94</strong><i><b /></i></div>
      <div className="canopy-readout canopy-readout-right"><span>signal / 04</span><strong>stable</strong><small>no visible stress</small></div>
      <div className="canopy-bottom-row"><span><span className="canopy-pulse-dot" /> scan complete</span><span>12:08:44</span></div>
    </div>
  );
}

function WaterlineScene({ compact }: { compact: boolean }) {
  const suffix = compact ? "mini" : "main";
  return (
    <div className="scene scene-waterline" role="img" aria-label="Waterline preview: layered irrigation channels flowing toward a crop row">
      <div className="water-sun" />
      <div className="water-topline"><span>WATERLINE / TODAY&apos;S WINDOW</span><span>06:20—08:10</span></div>
      <div className="water-horizon"><span /><span /><span /><span /><span /></div>
      <div className="water-message"><span>best next move</span><strong>give zone 04 a drink</strong><small>18 minutes · 24 L / tree</small></div>
      <svg className="water-art" viewBox="0 0 600 380" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id={`water-field-${suffix}`} x1="0" y1="0" x2="1" y2="1">
            <stop stopColor="#d8e7b9" /><stop offset="1" stopColor="#98c4a1" />
          </linearGradient>
          <linearGradient id={`water-flow-${suffix}`} x1="0" y1="0" x2="1" y2="0">
            <stop stopColor="#83d6d2" /><stop offset="0.55" stopColor="#2ba9a5" /><stop offset="1" stopColor="#097c78" />
          </linearGradient>
          <filter id={`water-shadow-${suffix}`} x="-25%" y="-35%" width="160%" height="180%">
            <feDropShadow dx="0" dy="14" stdDeviation="14" floodColor="#286f69" floodOpacity="0.22" />
          </filter>
        </defs>
        <path d="M30 280 C145 240 235 252 314 281 C405 315 500 274 582 244 L582 380 L30 380Z" fill={`url(#water-field-${suffix})`} opacity="0.74" />
        <g className="water-furrows" stroke="#4f9a83" strokeWidth="2" strokeOpacity="0.36">
          <path d="M24 320 C143 286 215 300 317 328 C419 357 503 319 590 289" /><path d="M20 350 C139 316 216 331 318 359 C420 388 505 350 592 320" /><path d="M18 380 C136 347 220 360 319 389 C423 416 505 380 596 350" />
        </g>
        <path d="M-12 268 C118 226 220 236 307 270 C401 307 492 263 617 220 L617 312 C493 350 407 361 306 322 C214 287 117 284 -12 324Z" fill={`url(#water-flow-${suffix})`} opacity="0.9" filter={`url(#water-shadow-${suffix})`} />
        <path className="water-flow-line" d="M-2 287 C118 249 214 254 305 287 C403 322 497 281 607 242" stroke="#d7ffff" strokeWidth="3" strokeLinecap="round" strokeDasharray="11 14" />
        <path d="M83 246 C156 220 228 224 303 250 C397 283 495 252 563 226" stroke="#ffffff" strokeOpacity="0.64" strokeWidth="2" strokeDasharray="3 13" />
        <g className="water-crop-row">
          <path d="M418 192 C430 160 437 131 429 98" stroke="#467c54" strokeWidth="4" strokeLinecap="round" /><path d="M429 137 C402 116 386 106 368 104" stroke="#467c54" strokeWidth="3" strokeLinecap="round" /><path d="M431 149 C458 125 477 112 497 111" stroke="#467c54" strokeWidth="3" strokeLinecap="round" /><path d="M431 113 C448 85 461 74 476 66" stroke="#467c54" strokeWidth="3" strokeLinecap="round" />
          <path d="M501 218 C503 173 494 143 479 112" stroke="#467c54" strokeWidth="4" strokeLinecap="round" /><path d="M491 161 C520 146 540 133 557 109" stroke="#467c54" strokeWidth="3" strokeLinecap="round" /><path d="M488 145 C468 120 452 103 440 81" stroke="#467c54" strokeWidth="3" strokeLinecap="round" />
          <ellipse cx="421" cy="101" rx="37" ry="11" fill="#77ac62" transform="rotate(25 421 101)" /><ellipse cx="472" cy="72" rx="35" ry="11" fill="#83bb68" transform="rotate(-36 472 72)" /><ellipse cx="493" cy="115" rx="38" ry="12" fill="#68a95f" transform="rotate(-23 493 115)" /><ellipse cx="543" cy="108" rx="39" ry="12" fill="#82b96c" transform="rotate(-32 543 108)" /><ellipse cx="393" cy="106" rx="32" ry="11" fill="#8abc70" transform="rotate(27 393 106)" />
        </g>
        <g className="water-droplets">
          <path d="M152 167 C152 154 164 144 164 134 C164 144 176 154 176 167 C176 180 152 180 152 167Z" fill="#2ba9a5" /><path d="M255 211 C255 200 265 191 265 182 C265 191 275 200 275 211 C275 222 255 222 255 211Z" fill="#6bc8c2" /><path d="M346 158 C346 146 357 137 357 127 C357 137 368 146 368 158 C368 170 346 170 346 158Z" fill="#1c9997" />
        </g>
      </svg>
      <div className="water-number"><strong>72</strong><span>%</span><small>of today&apos;s need met</small></div>
      <div className="water-bottom-row"><span><Droplets size={14} /> 3 zones on track</span><span>soil / 41%</span></div>
    </div>
  );
}
