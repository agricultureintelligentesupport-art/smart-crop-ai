import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  clampFindingBox, containedImageRect, imageMimeFromBytes, LEAF_MAX_BYTES, LEAF_RESPONSE_SCHEMA,
  leafMotionTiming, leafZoomTransform, parseLeafDiagnosis, resizedLeafDimensions, validateLeafImage,
} from "../../src/lib/leaf-diagnose";

const finding = { labelAr: "بقع بنية", box: [120, 200, 350, 460], severity: "medium" };
const diagnosis = {
  isPlant: true, plantNameAr: "طماطم", verdict: "diseased", diseaseNameAr: "اللفحة المبكرة",
  confidence: 0.84, findings: [finding],
};

test("leaf boxes clamp and round partial out-of-frame coordinates", () => {
  assert.deepEqual(clampFindingBox([-20, 30.4, 1010, 600.7]), [0, 30, 1000, 601]);
  assert.deepEqual(clampFindingBox([-100, -100, 1200, 1200]), [0, 0, 1000, 1000]);
});
for (const [name, value] of [
  ["zero-area", [1, 2, 1, 20]], ["reversed", [90, 5, 10, 20]],
  ["fully outside", [-10, 0, -1, 10]], ["NaN", [0, 0, Number.NaN, 50]],
  ["infinity", [0, 0, Infinity, 50]], ["numeric strings", [0, "2", 50, 50]],
  ["too short", [0, 0, 50]], ["too long", [0, 0, 50, 50, 80]],
  ["null", null], ["object", { ymin: 0 }], ["rounds to zero", [0, 0, 0.3, 0.3]],
] as const) {
  test(`leaf boxes drop ${name}`, () => assert.equal(clampFindingBox(value), null));
}

test("leaf parser accepts strict JSON and projects only the seven contract fields", () => {
  const result = parseLeafDiagnosis(JSON.stringify({ ...diagnosis, advice: "must never be returned" }));
  assert.deepEqual(Object.keys(result), LEAF_RESPONSE_SCHEMA.required);
  assert.deepEqual(result, diagnosis);
  assert.deepEqual(Object.keys(result.findings[0]), ["labelAr", "box", "severity"]);
});

test("leaf parser drops invalid findings BEFORE capping valid findings at five", () => {
  const invalid = [null, {}, { ...finding, severity: "critical" },
    { ...finding, labelAr: "هذه علامة وصفية طويلة جدا" },
    { ...finding, labelAr: "brown spots" }, { ...finding, labelAr: "بقع\nبنية" },
    { ...finding, box: [300, 20, 10, 200] }];
  const valid = Array.from({ length: 9 }, (_, i) => ({ ...finding, box: [-10, i * 10, 1020, i * 10 + 40] }));
  const result = parseLeafDiagnosis({ ...diagnosis, findings: [...invalid, ...valid] });
  assert.equal(result.findings.length, 5);
  assert.deepEqual(result.findings[0].box, [0, 0, 1000, 40]);
  assert.deepEqual(result.findings[4].box, [0, 40, 1000, 80]);
});

test("healthy and not-a-plant results have no disease or findings", () => {
  const healthy = parseLeafDiagnosis({ ...diagnosis, verdict: "healthy" });
  assert.equal(healthy.diseaseNameAr, "");
  assert.deepEqual(healthy.findings, []);
  const notPlant = parseLeafDiagnosis({ ...diagnosis, isPlant: false });
  assert.equal(notPlant.verdict, "uncertain");
  assert.equal(notPlant.plantNameAr, "");
  assert.equal(notPlant.diseaseNameAr, "");
  assert.deepEqual(notPlant.findings, []);
});

test("uncertain results never carry a disease name; missing disease downgrades to uncertain", () => {
  assert.equal(parseLeafDiagnosis({ ...diagnosis, verdict: "uncertain" }).diseaseNameAr, "");
  const unnamed = parseLeafDiagnosis({ ...diagnosis, diseaseNameAr: "" });
  assert.equal(unnamed.verdict, "uncertain");
  assert.equal(unnamed.diseaseNameAr, "");
});

test("leaf confidence is clamped to 0..1 without coercing strings", () => {
  assert.equal(parseLeafDiagnosis({ ...diagnosis, confidence: 5 }).confidence, 1);
  assert.equal(parseLeafDiagnosis({ ...diagnosis, confidence: -0.1 }).confidence, 0);
  for (const confidence of ["0.8", NaN, Infinity, undefined]) {
    assert.throws(() => parseLeafDiagnosis({ ...diagnosis, confidence }), /malformed/);
  }
});

test("leaf parser rejects fenced JSON, missing fields, paragraphs, English names and malformed roots", () => {
  for (const input of ["```json\n{}\n```", "not json", "null", [], {},
    { ...diagnosis, isPlant: "true" }, { ...diagnosis, verdict: "maybe" },
    { ...diagnosis, findings: {} }, { ...diagnosis, plantNameAr: "Tomato" },
    { ...diagnosis, diseaseNameAr: "فقرة\nثانية" }, { ...diagnosis, plantNameAr: "أ".repeat(65) },
    { ...diagnosis, diseaseNameAr: undefined }]) {
    assert.throws(() => parseLeafDiagnosis(input), /malformed/);
  }
});

const signatures = {
  "image/jpeg": new Uint8Array([255, 216, 255, 224]),
  "image/png": new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
  "image/webp": new Uint8Array([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80]),
};
for (const [type, bytes] of Object.entries(signatures)) {
  test(`leaf validation accepts ${type} and a matching magic signature`, () => {
    assert.equal(imageMimeFromBytes(bytes), type);
    assert.equal(validateLeafImage({ type, size: LEAF_MAX_BYTES }, bytes), null);
  });
}

test("leaf validation rejects oversize, empty, spoofed, SVG, GIF and unsupported MIME types", () => {
  assert.equal(validateLeafImage({ type: "image/png", size: LEAF_MAX_BYTES + 1 }), "too-large");
  for (const size of [0, -1, NaN, 1.5, Infinity]) assert.equal(validateLeafImage({ type: "image/png", size }), "invalid-input");
  for (const type of ["image/svg+xml", "image/gif", "image/jpg", "application/octet-stream", ""]) {
    assert.equal(validateLeafImage({ type, size: 20 }), "invalid-input");
  }
  assert.equal(validateLeafImage({ type: "image/jpeg", size: 20 }, signatures["image/png"]), "invalid-input");
  assert.equal(validateLeafImage({ type: "image/png", size: 20 }, new Uint8Array([1, 2])), "invalid-input");
  assert.equal(imageMimeFromBytes(new Uint8Array([71, 73, 70, 56])), null);
});

test("client resize math keeps aspect ratio, caps the longest side at 1280, and never upscales", () => {
  assert.deepEqual(resizedLeafDimensions({ width: 4000, height: 3000 }), { width: 1280, height: 960 });
  assert.deepEqual(resizedLeafDimensions({ width: 3000, height: 4000 }), { width: 960, height: 1280 });
  assert.deepEqual(resizedLeafDimensions({ width: 80, height: 50 }), { width: 80, height: 50 });
  assert.throws(() => resizedLeafDimensions({ width: 0, height: 100 }), /invalid-input/);
});

test("contain geometry respects both portrait and landscape letterboxing", () => {
  assert.deepEqual(containedImageRect({ width: 100, height: 200 }, { width: 300, height: 240 }),
    { x: 90, y: 0, width: 120, height: 240 });
  assert.deepEqual(containedImageRect({ width: 200, height: 100 }, { width: 300, height: 240 }),
    { x: 0, y: 45, width: 300, height: 150 });
});

test("zoom math centers a finding with capped scale and handles toggle-out", () => {
  const size = { width: 300, height: 300 };
  assert.deepEqual(leafZoomTransform([200, 200, 400, 400], size, size), { scale: 3, translateX: -120, translateY: -120 });
  assert.deepEqual(leafZoomTransform(null, size, size), { scale: 1, translateX: 0, translateY: 0 });
  assert.deepEqual(leafZoomTransform([0, 0, 1000, 1000], size, size), { scale: 1, translateX: 0, translateY: 0 });
});

test("zoom math clamps edge findings without panning the image outside the frame", () => {
  const size = { width: 300, height: 300 };
  const topLeft = leafZoomTransform([0, 0, 100, 100], size, size);
  const bottomRight = leafZoomTransform([900, 900, 1000, 1000], size, size);
  assert.equal(topLeft.translateX, 0);
  assert.equal(topLeft.translateY, 0);
  assert.equal(bottomRight.translateX, -600);
  assert.equal(bottomRight.translateY, -600);
});

test("zoom math includes contain offsets and safely handles unknown dimensions", () => {
  const image = { width: 100, height: 200 };
  const frame = { width: 300, height: 240 };
  const zoom = leafZoomTransform([400, 400, 600, 600], image, frame);
  assert.equal(zoom.scale, 3);
  assert.equal(90 + zoom.translateX + 60 * zoom.scale, 150);
  assert.equal(zoom.translateY + 120 * zoom.scale, 120);
  assert.deepEqual(leafZoomTransform([100, 100, 200, 200], image, { width: 0, height: 0 }),
    { scale: 1, translateX: 0, translateY: 0 });
});

test("reduced-motion path keeps a static minimum scan but reveals/zooms instantly", () => {
  assert.deepEqual(leafMotionTiming(false), { minimumScanMs: 2500, dimFadeMs: 350, findingStaggerMs: 600, zoomMs: 450 });
  assert.deepEqual(leafMotionTiming(true), { minimumScanMs: 2500, dimFadeMs: 0, findingStaggerMs: 0, zoomMs: 0 });
  const css = readFileSync(new URL("../../src/components/dashboard/scan-card.module.css", import.meta.url), "utf8");
  const reduced = css.split("@media (prefers-reduced-motion: reduce)")[1].split("@media")[0];
  assert.match(reduced, /animation: none !important; transition: none !important/);
  assert.match(reduced, /stroke-dashoffset: 0/);
});
