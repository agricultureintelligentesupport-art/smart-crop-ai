/** Display-only geometry. WGS84 stays unchanged in storage and analysis. */
import { normalizeRing, type Ring, type Position } from "@/lib/geo/polygon";

export function mercator([lon, lat]: Position): Position {
  const radians = Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180;
  return [(lon + 180) / 360, (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2];
}

export function plotGeometry(ring: Ring) {
  const vertices = normalizeRing(ring);
  const projected = vertices.map(mercator);
  const west = Math.min(...projected.map(([x]) => x));
  const north = Math.min(...projected.map(([, y]) => y));
  const width = Math.max(...projected.map(([x]) => x)) - west;
  const height = Math.max(...projected.map(([, y]) => y)) - north;
  // A single uniform scale preserves proportions, including very small plots.
  const scale = 1000 / Math.max(width, height, Number.EPSILON);
  return {
    west, north, width, height,
    svgWidth: width * scale,
    svgHeight: height * scale,
    points: projected.map(([x, y]) => `${(x - west) * scale},${(y - north) * scale}`).join(" "),
    vertices: vertices.length,
  };
}
export type PlotGeometry = ReturnType<typeof plotGeometry>;

/** Closed-ring great-circle perimeter, in metres (same radius as ringAreaHa). */
export function perimeterMetres(raw: Ring): number {
  const ring = normalizeRing(raw);
  const rad = Math.PI / 180;
  return ring.reduce((sum, [lon, lat], i) => {
    const [nextLon, nextLat] = ring[(i + 1) % ring.length];
    const a = Math.sin((nextLat - lat) * rad / 2) ** 2
      + Math.cos(lat * rad) * Math.cos(nextLat * rad) * Math.sin((nextLon - lon) * rad / 2) ** 2;
    return sum + 2 * 6378137 * Math.asin(Math.sqrt(Math.min(1, a)));
  }, 0);
}

export function tileGrid(g: PlotGeometry, textureSize = 1024) {
  let zoom = Math.max(0, Math.min(23, Math.ceil(Math.log2(textureSize / (256 * Math.max(g.width, g.height))))));
  const at = (z: number) => {
    const n = 2 ** z;
    const left = Math.floor(g.west * n), top = Math.floor(g.north * n);
    const right = Math.floor((g.west + g.width) * n), bottom = Math.floor((g.north + g.height) * n);
    return { zoom: z, left, top, right, bottom, count: (right - left + 1) * (bottom - top + 1) };
  };
  while (zoom > 0 && at(zoom).count > 36) zoom--;
  return at(zoom);
}

/** Source crop for a target tile within a lower-resolution genuine ancestor. */
export function ancestorCrop(x: number, y: number, levels: number, size = 256) {
  const factor = 2 ** levels, span = size / factor;
  return { x: (x % factor) * span, y: (y % factor) * span, size: span };
}
