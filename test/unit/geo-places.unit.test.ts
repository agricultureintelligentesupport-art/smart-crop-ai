/**
 * Place-search parsing: the pure half of `/api/geocode`.
 *
 * The old `leaflet-control-geocoder` crashed exactly here — its default
 * template read `result.address.road` on responses requested with
 * `addressdetails=0`, throwing inside the result mapping and leaving the
 * control's spinner running forever. These tests pin the contract the new
 * pipeline relies on: unknown upstream shapes must degrade to fewer or empty
 * results, never to an exception.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { normalizeQuery, parseNominatimResults, splitDisplayName } from "@/lib/geo/places";

const KHENCHELA_CITY = {
  place_id: 55236293,
  lat: "35.4301540",
  lon: "7.1457110",
  name: "خنشلة",
  display_name: "خنشلة, دائرة خنشلة, خنشلة, الجزائر",
  address: { city: "خنشلة", county: "دائرة خنشلة", state: "خنشلة", country: "الجزائر" },
};

const KHENCHELA_STATE = {
  place_id: 52639528,
  lat: "34.9133455",
  lon: "6.9059431",
  name: "خنشلة",
  display_name: "خنشلة, الجزائر",
  address: { state: "خنشلة", country: "الجزائر" },
};

test("splitDisplayName keeps the administrative path and drops the country", () => {
  assert.equal(splitDisplayName(KHENCHELA_CITY.display_name, "خنشلة"), "دائرة خنشلة، خنشلة");
});

test("splitDisplayName returns null when only the country followed the name", () => {
  // A wilaya-level result has no context under the country — the row shows
  // the bold name alone instead of an empty lighter line.
  assert.equal(splitDisplayName(KHENCHELA_STATE.display_name, "خنشلة"), null);
});

test("splitDisplayName handles the French locale and repeated segments", () => {
  assert.equal(splitDisplayName("Khenchela, Daïra de Khenchela, Algérie", "Khenchela"), "Daïra de Khenchela");
});

test("normalizeQuery collapses whitespace so cache keys stay canonical", () => {
  assert.equal(normalizeQuery("  خنشلة   الديس  "), "خنشلة الديس");
  assert.equal(normalizeQuery("\tBiskra\n"), "Biskra");
});

test("parseNominatimResults shapes a real Khenchela response", () => {
  const places = parseNominatimResults([KHENCHELA_STATE, KHENCHELA_CITY]);
  assert.equal(places.length, 2);
  assert.equal(places[0].name, "خنشلة");
  assert.equal(places[0].secondary, null);
  assert.equal(places[1].secondary, "دائرة خنشلة، خنشلة");
  assert.equal(places[1].lat, 35.430154);
  assert.equal(places[1].lng, 7.145711);
});

test("parseNominatimResults never throws on a malformed payload", () => {
  // Each of these killed the old geocoder in one way or another; all must
  // yield an empty list now.
  assert.deepEqual(parseNominatimResults(null), []);
  assert.deepEqual(parseNominatimResults({ error: "boom" }), []);
  assert.deepEqual(parseNominatimResults([{ lat: "nope", lon: "0", display_name: "x" }]), []);
  assert.deepEqual(parseNominatimResults([{ place_id: 1, lat: "1", lon: "2" }]), []);
  assert.deepEqual(parseNominatimResults([undefined, null, 42]), []);
});

test("parseNominatimResults caps the list at five rows", () => {
  const flood = Array.from({ length: 12 }, (_, i) => ({
    place_id: i,
    lat: String(i),
    lon: String(i),
    name: `مكان ${i}`,
    display_name: `مكان ${i}, الجزائر`,
  }));
  assert.equal(parseNominatimResults(flood).length, 5);
});

test("parseNominatimResults falls back to the first display_name segment as the name", () => {
  const unnamed = { place_id: 9, lat: "35.4", lon: "7.1", display_name: "شوارع النصر, خنشلة, الجزائر" };
  const [place] = parseNominatimResults([unnamed]);
  assert.equal(place.name, "شوارع النصر");
  assert.equal(place.secondary, "خنشلة");
});
