/**
 * Quick-scan DEMO payload for the Home card ("صحة النبات") — the dashboard's
 * counterpart to `@/lib/assistant/demo-mock`.
 *
 * WHY THIS FILE EXISTS
 *   The Home card posts the picked photo to `/api/scan` first. While the demo
 *   mock is enabled that route answers the scripted Black Spot diagnosis
 *   below — after a 5 s simulated vision round-trip — so the recording always
 *   shows the same curated result instead of a provider-dependent one.
 *
 * HOW IT IS WIRED
 *   • `src/app/api/scan/route.ts` returns {@link DEMO_SCAN_PAYLOAD} verbatim;
 *   • `src/components/dashboard/ScanCard` maps it onto the card's own
 *     `LeafDiagnosis` contract through {@link demoScanToDiagnosis} — the card
 *     renders `diseaseNameAr`, `plantNameAr`, the confidence meter and the
 *     hotspot findings, so the scripted diagnosis looks exactly like a real
 *     one. `description` and `treatment` ride along in the API payload (the
 *     card shows them in future revisions).
 *
 * OFF BY DEFAULT? No: the flag is shared with the chat mock — see
 * `isDemoMockEnabled` in `@/lib/assistant/demo-mock`. `DEMO_MOCK=0` disables
 * BOTH, `/api/scan` then answers 404 and the card walks its real pipeline
 * (`/api/leaf-diagnose`) untouched, which is what production pins.
 *
 * Dependency-free and client-safe: the card imports the adapter below, so this
 * module must never touch server-only APIs or secrets.
 */

import { parseLeafDiagnosis, type LeafBox, type LeafDiagnosis, type LeafSeverity } from "@/lib/leaf-diagnose";

/** Simulated vision round-trip for the quick scan (mirrors the chat's photo beat). */
export const DEMO_SCAN_DELAY_MS = 5000;

export interface DemoScanEnvelope {
  status: "success";
  data: {
    /** e.g. "البقعة السوداء (Black Spot)". */
    diseaseName: string;
    /** e.g. "ورد (Rose)". */
    plantType: string;
    /** Arabic verdict, e.g. "مصابة". */
    status: string;
    /** Confidence as a PERCENT (0–100), as the card's API contract states. */
    confidence: number;
    /** Pre-formatted chip text, e.g. "95% · ثقة مرتفعة". */
    confidenceText: string;
    description: string;
    hotspots: Array<{ id: number; label: string }>;
    treatment: { product: string; dose: string; method: string };
  };
}

/**
 * The scripted answer, byte-for-byte as specified. Kept as a frozen literal so
 * the route can return it directly and the tests can assert it exactly.
 */
export const DEMO_SCAN_PAYLOAD: DemoScanEnvelope = {
  status: "success",
  data: {
    diseaseName: "البقعة السوداء (Black Spot)",
    plantType: "ورد (Rose)",
    status: "مصابة",
    confidence: 95,
    confidenceText: "95% · ثقة مرتفعة",
    description:
      "تُظهر الصورة إصابة فطرية شائعة بنقاط وبقع سوداء محاطة بهالة صفراء، تنتج عن فطريات (Diplocarpon rosae) وتنتشر عبر الرطوبة العالية.",
    hotspots: [
      { id: 1, label: "اصفرار وتبقعات سوداء" },
      { id: 2, label: "بقع سوداء واصفرار الورقة" },
      { id: 3, label: "بقع سوداء مبكرة" },
    ],
    treatment: {
      product: "مبيد فطري نحاسي أو مانكوزيب 80%",
      dose: "1.5 غرام لكل لتر ماء",
      method: "رش ورقي متجانس صباحاً مع إزالة الأوراق المصابة.",
    },
  },
};

/**
 * Hotspot boxes on the ORIGINAL photo, in the card's 0–1000 coordinate space
 * (see `clampFindingBox`). The scripted payload carries ids + labels only, so
 * the adapter anchors each hotspot on the leaf: top half, right-lower half and
 * bottom-left — the spread a real triple finding shows.
 */
const HOTSPOT_BOXES: LeafBox[] = [
  [320, 200, 660, 520],
  [560, 460, 880, 780],
  [170, 560, 470, 850],
];

/** Severity per hotspot, matching the 95 % infection the payload reports. */
const HOTSPOT_SEVERITIES: LeafSeverity[] = ["high", "high", "medium"];

/** Arabic verdict → the card's verdict enum. */
function verdictFromStatus(status: string): LeafDiagnosis["verdict"] {
  const value = status.trim();
  if (value === "سليمة" || value.toLowerCase() === "healthy") return "healthy";
  if (value === "غير مؤكد" || value.toLowerCase() === "uncertain") return "uncertain";
  return value ? "diseased" : "uncertain";
}

/** Narrow an unknown response body to the scripted envelope. */
export function isDemoScanEnvelope(payload: unknown): payload is DemoScanEnvelope {
  if (typeof payload !== "object" || payload === null) return false;
  const envelope = payload as Partial<DemoScanEnvelope>;
  if (envelope.status !== "success") return false;
  const data = envelope.data;
  if (typeof data !== "object" || data === null) return false;
  return (
    typeof data.diseaseName === "string" &&
    typeof data.plantType === "string" &&
    typeof data.status === "string" &&
    typeof data.confidence === "number" &&
    Number.isFinite(data.confidence) &&
    Array.isArray(data.hotspots) &&
    data.hotspots.every(
      (hotspot) => typeof hotspot === "object" && hotspot !== null && typeof hotspot.label === "string",
    )
  );
}

/**
 * Map the quick-scan envelope onto the card's `LeafDiagnosis` contract, or
 * `null` when the payload is not a demo envelope (the caller then walks the
 * real `/api/leaf-diagnose` pipeline).
 *
 * The confidence is converted from the payload's PERCENT to the card's 0–1
 * ratio, and the result is run through the SHARED `parseLeafDiagnosis`, so the
 * scripted answer is held to the exact same validation as a model answer
 * (Arabic-only labels, 4-word hotspot labels, clamped confidence…).
 */
export function demoScanToDiagnosis(payload: unknown): LeafDiagnosis | null {
  if (!isDemoScanEnvelope(payload)) return null;
  const { data } = payload;
  try {
    return parseLeafDiagnosis({
      isPlant: true,
      plantNameAr: data.plantType,
      verdict: verdictFromStatus(data.status),
      diseaseNameAr: data.diseaseName,
      confidence: data.confidence > 1 ? data.confidence / 100 : data.confidence,
      findings: data.hotspots.slice(0, HOTSPOT_BOXES.length).map((hotspot, index) => ({
        labelAr: hotspot.label,
        box: HOTSPOT_BOXES[index],
        severity: HOTSPOT_SEVERITIES[index] ?? "medium",
      })),
    });
  } catch {
    // A malformed scripted payload must never break a scan: fall back.
    return null;
  }
}
