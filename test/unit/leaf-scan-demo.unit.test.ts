/**
 * Quick-scan demo endpoint (`/api/scan` + `@/lib/leaf-scan-demo`).
 *
 * The Home "صحة النبات" card must show the SAME curated diagnosis on every
 * recording, after a 5 s vision beat — and must fall back to the real pipeline
 * the moment the demo flag is off. This suite pins:
 *   • the response body is exactly the specified envelope (nothing renamed or
 *     trimmed by a serializer);
 *   • the adapter onto the card's `LeafDiagnosis` contract survives the shared
 *     validator (Arabic labels, 4-word hotspot labels, 0–1 confidence…);
 *   • the kill switch: `DEMO_MOCK=0` → instant 404, and the card's caller then
 *     uses `/api/leaf-diagnose`;
 *   • input validation still runs (a bad upload never gets the scripted card).
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { POST } from "../../src/app/api/scan/route";
import {
  DEMO_SCAN_DELAY_MS,
  DEMO_SCAN_PAYLOAD,
  demoScanToDiagnosis,
  isDemoScanEnvelope,
} from "../../src/lib/leaf-scan-demo";

const TOUCHED_ENV = /^(DEMO_MOCK|PHYTOSCAN_DEMO_MOCK)$/;
const originalEnv: Record<string, string | undefined> = {};
for (const [name, value] of Object.entries(process.env)) {
  if (TOUCHED_ENV.test(name)) originalEnv[name] = value;
}

afterEach(() => {
  for (const name of Object.keys(process.env)) {
    if (TOUCHED_ENV.test(name)) delete process.env[name];
  }
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** A minimal but structurally valid JPEG (magic bytes included). */
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

function multipartRequest(bytes: Uint8Array = JPEG_BYTES, type = "image/jpeg") {
  const form = new FormData();
  form.append("image", new File([bytes as BlobPart], "leaf.jpg", { type }));
  return new Request("http://localhost/api/scan", { method: "POST", body: form });
}

function jsonRequest(data: string, mimeType = "image/jpeg") {
  return new Request("http://localhost/api/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: { data, mimeType } }),
  });
}

/* ------------------------------------------------------------------ */
/*  The payload                                                        */
/* ------------------------------------------------------------------ */

test("the scripted envelope matches the specification exactly", () => {
  assert.deepEqual(DEMO_SCAN_PAYLOAD, {
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
  });
  assert.equal(isDemoScanEnvelope(DEMO_SCAN_PAYLOAD), true);
});

/* ------------------------------------------------------------------ */
/*  Adapter onto the card's contract                                   */
/* ------------------------------------------------------------------ */

test("the adapter renders the envelope as a full LeafDiagnosis card", () => {
  const diagnosis = demoScanToDiagnosis(DEMO_SCAN_PAYLOAD);
  assert.ok(diagnosis, "expected the envelope to adapt");
  assert.equal(diagnosis.isPlant, true);
  assert.equal(diagnosis.verdict, "diseased");
  assert.equal(diagnosis.diseaseNameAr, "البقعة السوداء (Black Spot)");
  assert.equal(diagnosis.plantNameAr, "ورد (Rose)");
  // Percent → the card's 0–1 ratio (rendered back as "95%").
  assert.equal(diagnosis.confidence, 0.95);
  assert.deepEqual(
    diagnosis.findings.map((finding) => [finding.labelAr, finding.severity]),
    [
      ["اصفرار وتبقعات سوداء", "high"],
      ["بقع سوداء واصفرار الورقة", "high"],
      ["بقع سوداء مبكرة", "medium"],
    ],
  );
  // Every hotspot keeps a drawable box inside the 0–1000 canvas.
  for (const finding of diagnosis.findings) {
    const [x1, y1, x2, y2] = finding.box;
    assert.ok(x1 < x2 && y1 < y2, `invalid box ${finding.box.join(",")}`);
    assert.ok([x1, y1, x2, y2].every((n) => n >= 0 && n <= 1000));
  }
});

test("the adapter ignores anything that is not a demo envelope", () => {
  for (const payload of [
    null,
    undefined,
    {},
    { status: "error", error: "scan-demo-disabled" },
    { status: "success" },
    // A real /api/leaf-diagnose body has no `status: "success"` envelope.
    { isPlant: true, verdict: "diseased", diseaseNameAr: "اللفحة", confidence: 0.9, findings: [] },
    { ...DEMO_SCAN_PAYLOAD, data: { ...DEMO_SCAN_PAYLOAD.data, hotspots: "nope" } },
  ]) {
    assert.equal(demoScanToDiagnosis(payload), null, `should ignore ${JSON.stringify(payload)}`);
  }
});

/* ------------------------------------------------------------------ */
/*  The endpoint                                                       */
/* ------------------------------------------------------------------ */

test("DEMO_MOCK=0 answers 404 instantly so the card keeps the real pipeline", async () => {
  process.env.DEMO_MOCK = "0";
  const started = Date.now();
  const response = await POST(multipartRequest());
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { status: "error", error: "scan-demo-disabled" });
  assert.ok(Date.now() - started < 1000, "a disabled endpoint must not simulate the 5 s beat");
});

test("with the demo on, a multipart upload returns the envelope after ~5 s", async () => {
  delete process.env.DEMO_MOCK; // ON by default (shared DEMO_MOCK flag).
  const started = Date.now();
  const response = await POST(multipartRequest());
  const elapsed = Date.now() - started;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store, private");
  assert.deepEqual(await response.json(), DEMO_SCAN_PAYLOAD);
  assert.ok(elapsed >= DEMO_SCAN_DELAY_MS - 20, `expected the 5 s beat, took ${elapsed} ms`);
});

test("the JSON body shape is accepted too (manual testing convenience)", async () => {
  delete process.env.DEMO_MOCK;
  const response = await POST(jsonRequest(Buffer.from(JPEG_BYTES).toString("base64")));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.diseaseName, "البقعة السوداء (Black Spot)");
});

test("input validation runs before the demo gate", async () => {
  // No key configured + no demo needed: a bad upload is rejected as such.
  const missing = await POST(new Request("http://localhost/api/scan", { method: "POST" }));
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error, "invalid-input");

  const wrongType = await POST(multipartRequest(JPEG_BYTES, "text/plain"));
  assert.equal(wrongType.status, 400);

  const magicMismatch = await POST(multipartRequest(new Uint8Array([1, 2, 3, 4]), "image/jpeg"));
  assert.equal(magicMismatch.status, 400);

  const jsonMissing = await POST(
    new Request("http://localhost/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }),
  );
  assert.equal(jsonMissing.status, 400);
});
