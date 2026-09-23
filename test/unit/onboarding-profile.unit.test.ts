/**
 * Unit tests for the onboarding farm profile (run in plain Node — no browser
 * needed).
 *
 *   npm run test:unit
 *
 * Covers the additive registration-flow fields: land-size parsing, wilaya
 * geolocation matching, and the session binding of the new profile fields.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { parseLandSizeHa } from "../../src/lib/auth/validation";
import {
  WILAYA_COORDS,
  findNearestWilaya,
  getBrowserPosition,
  haversineKm,
} from "../../src/lib/auth/geolocation";
import { resolveSessionBinding } from "../../src/lib/auth/session";
import { WILAYAS } from "../../src/lib/wilayas";

/* ------------------------------------------------------------------ */
/*  1. Land-size parsing                                               */
/* ------------------------------------------------------------------ */

test("parseLandSizeHa accepts plain hectares", () => {
  assert.equal(parseLandSizeHa("2.5"), 2.5);
  assert.equal(parseLandSizeHa(" 3 "), 3);
  assert.equal(parseLandSizeHa("0.25"), 0.25);
});

test("parseLandSizeHa accepts comma and Arabic decimal separators", () => {
  assert.equal(parseLandSizeHa("2,5"), 2.5);
  assert.equal(parseLandSizeHa("٢٫٥"), 2.5);
  assert.equal(parseLandSizeHa("٢.٥"), 2.5);
});

test("parseLandSizeHa rejects empty, zero, negative and absurd values", () => {
  assert.equal(parseLandSizeHa(""), null);
  assert.equal(parseLandSizeHa("   "), null);
  assert.equal(parseLandSizeHa("0"), null);
  assert.equal(parseLandSizeHa("-1"), null);
  assert.equal(parseLandSizeHa("abc"), null);
  assert.equal(parseLandSizeHa("12ha"), null);
  assert.equal(parseLandSizeHa("9999999999"), null);
});

/* ------------------------------------------------------------------ */
/*  2. Wilaya geolocation matching                                     */
/* ------------------------------------------------------------------ */

test("WILAYA_COORDS covers every wilaya exactly once", () => {
  const codes = Object.keys(WILAYA_COORDS).sort();
  assert.deepEqual(
    codes,
    WILAYAS.map((w) => w.code).sort(),
  );
  for (const point of Object.values(WILAYA_COORDS)) {
    assert.ok(Number.isFinite(point.lat) && Number.isFinite(point.lon));
    // Rough Algeria bounding box (mainland + far south).
    assert.ok(point.lat >= 18 && point.lat <= 38);
    assert.ok(point.lon >= -9 && point.lon <= 13);
  }
});

test("haversineKm is zero for identical points and sane for Algiers→Oran", () => {
  assert.equal(haversineKm(36.75, 3.06, 36.75, 3.06), 0);
  const km = haversineKm(36.75, 3.06, 35.7, -0.64);
  assert.ok(km > 300 && km < 420, `expected ~360km, got ${km}`);
});

test("findNearestWilaya resolves province capitals to their own code", () => {
  assert.equal(findNearestWilaya(36.75, 3.06).code, "16"); // Alger
  assert.equal(findNearestWilaya(35.7, -0.64).code, "31"); // Oran
  assert.equal(findNearestWilaya(34.85, 5.73).code, "07"); // Biskra
  assert.equal(findNearestWilaya(22.79, 5.52).code, "11"); // Tamanrasset
  assert.equal(findNearestWilaya(36.9, 7.77).code, "23"); // Annaba
});

test("findNearestWilaya never throws and falls back for garbage input", () => {
  const fallback = findNearestWilaya(Number.NaN, Number.NaN);
  assert.equal(fallback.code, "07");
  // Mid-Mediterranean: still resolves to *some* coastal wilaya.
  const sea = findNearestWilaya(37.5, 4.0);
  assert.match(sea.code, /^\d{2}$/);
});

test("getBrowserPosition rejects unsupported without geolocation (SSR/Node)", async () => {
  const nav = (globalThis as Record<string, unknown>).navigator as
    | Record<string, unknown>
    | undefined;
  assert.equal(nav === undefined || !("geolocation" in nav), true);
  await assert.rejects(
    () => getBrowserPosition(50),
    (reason: unknown) => reason === "unsupported",
  );
});

/* ------------------------------------------------------------------ */
/*  3. Session binding of the farm fields                              */
/* ------------------------------------------------------------------ */

test("resolveSessionBinding isolates crop/land on account switch", () => {
  const binding = resolveSessionBinding(
    { uid: "user-B", role: null, wilayaCode: null, preferredCrop: null, landSizeHa: null },
    {
      uid: "user-A",
      method: "google",
      displayName: "Farmer A",
      role: "farmer",
      wilayaCode: "16",
      preferredCrop: "olive",
      landSizeHa: 2.5,
      updatedAt: Date.now(),
    },
    { role: "investor", wilayaCode: "31", preferredCrop: "wheat", landSizeHa: 9 },
  );
  assert.deepEqual(binding, {
    role: null,
    wilayaCode: null,
    preferredCrop: null,
    landSizeHa: null,
    uidChanged: true,
  });
});

test("resolveSessionBinding merges crop/land session > cached > device", () => {
  const previous = {
    uid: "user-A",
    method: "google",
    displayName: "Farmer A",
    role: "farmer",
    wilayaCode: "16",
    preferredCrop: "olive",
    landSizeHa: 2.5,
    updatedAt: Date.now(),
  } as const;
  // Session values win…
  assert.deepEqual(
    resolveSessionBinding(
      { uid: "user-A", role: null, wilayaCode: null, preferredCrop: "dates", landSizeHa: 4 },
      { ...previous },
      null,
    ).preferredCrop,
    "dates",
  );
  // …then the cached profile…
  assert.deepEqual(
    resolveSessionBinding(
      { uid: "user-A", role: null, wilayaCode: null, preferredCrop: null, landSizeHa: null },
      { ...previous },
      null,
    ),
    {
      role: "farmer",
      wilayaCode: "16",
      preferredCrop: "olive",
      landSizeHa: 2.5,
      uidChanged: false,
    },
  );
  // …then the device prefs.
  assert.deepEqual(
    resolveSessionBinding(
      { uid: "user-A", role: null, wilayaCode: null, preferredCrop: null, landSizeHa: null },
      null,
      { role: "investor", wilayaCode: "31", preferredCrop: "wheat", landSizeHa: 9 },
    ),
    {
      role: "investor",
      wilayaCode: "31",
      preferredCrop: "wheat",
      landSizeHa: 9,
      uidChanged: false,
    },
  );
});
