/**
 * Browser geolocation → wilaya matching for the onboarding wilaya step.
 *
 * Pure helpers (`haversineKm`, `findNearestWilaya`) plus a thin promise
 * wrapper around `navigator.geolocation.getCurrentPosition`. The coordinates
 * below are approximate province-capital locations — good enough to pick the
 * *nearest* wilaya as a suggestion the user can still override manually.
 *
 * Deliberately dependency-free and `window`-guarded so plain `node --test`
 * can load this module (see `test/unit/onboarding-profile.unit.test.ts`).
 */

export interface WilayaCoords {
  lat: number;
  lon: number;
}

/** Approximate capital coordinates per wilaya code (WGS84 decimal degrees). */
export const WILAYA_COORDS: Record<string, WilayaCoords> = {
  "01": { lat: 27.87, lon: -0.29 }, // Adrar
  "02": { lat: 36.16, lon: 1.33 }, // Chlef
  "03": { lat: 33.8, lon: 2.87 }, // Laghouat
  "04": { lat: 35.87, lon: 7.11 }, // Oum El Bouaghi
  "05": { lat: 35.55, lon: 6.17 }, // Batna
  "06": { lat: 36.75, lon: 5.08 }, // Béjaïa
  "07": { lat: 34.85, lon: 5.73 }, // Biskra
  "08": { lat: 31.62, lon: -2.21 }, // Béchar
  "09": { lat: 36.47, lon: 2.83 }, // Blida
  "10": { lat: 36.37, lon: 3.9 }, // Bouira
  "11": { lat: 22.79, lon: 5.52 }, // Tamanrasset
  "12": { lat: 35.4, lon: 8.12 }, // Tébessa
  "13": { lat: 34.88, lon: -1.31 }, // Tlemcen
  "14": { lat: 35.37, lon: 1.32 }, // Tiaret
  "15": { lat: 36.72, lon: 4.05 }, // Tizi Ouzou
  "16": { lat: 36.75, lon: 3.06 }, // Alger
  "17": { lat: 34.67, lon: 3.26 }, // Djelfa
  "18": { lat: 36.82, lon: 5.77 }, // Jijel
  "19": { lat: 36.19, lon: 5.41 }, // Sétif
  "20": { lat: 34.83, lon: 0.15 }, // Saïda
  "21": { lat: 36.88, lon: 6.91 }, // Skikda
  "22": { lat: 35.19, lon: -0.63 }, // Sidi Bel Abbès
  "23": { lat: 36.9, lon: 7.77 }, // Annaba
  "24": { lat: 36.46, lon: 7.43 }, // Guelma
  "25": { lat: 36.37, lon: 6.61 }, // Constantine
  "26": { lat: 36.26, lon: 2.75 }, // Médéa
  "27": { lat: 35.93, lon: 0.09 }, // Mostaganem
  "28": { lat: 35.72, lon: 4.55 }, // M'Sila
  "29": { lat: 35.4, lon: 0.14 }, // Mascara
  "30": { lat: 31.95, lon: 5.33 }, // Ouargla
  "31": { lat: 35.7, lon: -0.64 }, // Oran
  "32": { lat: 33.68, lon: 1.02 }, // El Bayadh
  "33": { lat: 26.51, lon: 8.47 }, // Illizi
  "34": { lat: 36.07, lon: 4.77 }, // Bordj Bou Arreridj
  "35": { lat: 36.77, lon: 3.48 }, // Boumerdès
  "36": { lat: 36.77, lon: 8.31 }, // El Tarf
  "37": { lat: 27.67, lon: -8.15 }, // Tindouf
  "38": { lat: 35.61, lon: 1.81 }, // Tissemsilt
  "39": { lat: 33.37, lon: 6.86 }, // El Oued
  "40": { lat: 35.43, lon: 7.14 }, // Khenchela
  "41": { lat: 36.28, lon: 7.95 }, // Souk Ahras
  "42": { lat: 36.59, lon: 2.45 }, // Tipaza
  "43": { lat: 36.45, lon: 6.26 }, // Mila
  "44": { lat: 36.26, lon: 1.97 }, // Aïn Defla
  "45": { lat: 33.27, lon: -0.31 }, // Naâma
  "46": { lat: 35.3, lon: -1.14 }, // Aïn Témouchent
  "47": { lat: 32.49, lon: 3.67 }, // Ghardaïa
  "48": { lat: 35.74, lon: 0.56 }, // Relizane
  "49": { lat: 33.95, lon: 5.92 }, // El M'Ghair
  "50": { lat: 30.58, lon: 2.88 }, // El Menia
  "51": { lat: 34.42, lon: 5.08 }, // Ouled Djellal
  "52": { lat: 21.33, lon: 0.95 }, // Bordj Baji Mokhtar
  "53": { lat: 30.13, lon: -2.17 }, // Béni Abbès
  "54": { lat: 29.26, lon: 0.23 }, // Timimoun
  "55": { lat: 33.1, lon: 6.06 }, // Touggourt
  "56": { lat: 24.55, lon: 9.48 }, // Djanet
  "57": { lat: 27.2, lon: 2.47 }, // In Salah
  "58": { lat: 19.57, lon: 5.77 }, // In Guezzam
};

/** Great-circle distance in kilometres between two WGS84 points. */
export function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface NearestWilaya {
  /** Two-digit wilaya code, e.g. "16". */
  code: string;
  /** Distance to that wilaya's reference point, in kilometres. */
  distanceKm: number;
}

/**
 * Closest wilaya to a GPS fix. Never throws for finite inputs — with no
 * usable table entry it falls back to the national default code.
 */
export function findNearestWilaya(lat: number, lon: number): NearestWilaya {
  let best: NearestWilaya = { code: "07", distanceKm: Number.POSITIVE_INFINITY };
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return best;
  for (const [code, point] of Object.entries(WILAYA_COORDS)) {
    const distanceKm = haversineKm(lat, lon, point.lat, point.lon);
    if (distanceKm < best.distanceKm) best = { code, distanceKm };
  }
  return best;
}

export type GeoFailure = "unsupported" | "denied" | "unavailable" | "timeout";

export interface GeoFix {
  lat: number;
  lon: number;
}

/**
 * One-shot browser position lookup. Resolves with the fix, rejects with a
 * `GeoFailure` kind the UI maps onto gentle fallback copy (never a hard
 * error — the manual wilaya search always stays available).
 */
export function getBrowserPosition(timeoutMs = 12_000): Promise<GeoFix> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      reject("unsupported" satisfies GeoFailure);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ lat: position.coords.latitude, lon: position.coords.longitude }),
      (error) => {
        if (error.code === error.PERMISSION_DENIED) reject("denied" satisfies GeoFailure);
        else if (error.code === error.TIMEOUT) reject("timeout" satisfies GeoFailure);
        else reject("unavailable" satisfies GeoFailure);
      },
      { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 600_000 },
    );
  });
}
