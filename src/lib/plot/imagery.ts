/** Esri display texture only. Never used by the satellite analysis pipeline. */
import { ancestorCrop, tileGrid, type PlotGeometry } from "./geometry";

const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer";

/**
 * Esri can return its gray, text-bearing 'not available' image with HTTP 200.
 * Cache availability alone is not proof of imagery. Reject neutral/flat tiles
 * conservatively; a false rejection costs resolution, never displays a fake tile.
 * Inspect CORS-readable pixels before anything reaches the output canvas.
 */
export function hasImageryPixels(rgba: ArrayLike<number>): boolean {
  const count = rgba.length / 4;
  if (!count) return false;
  let transparent = 0, neutral = 0;
  const grayBins = new Array<number>(32).fill(0);
  let min = 255, max = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    if (rgba[i + 3] < 250) transparent++;
    const high = Math.max(r, g, b), low = Math.min(r, g, b);
    const luminance = (r + g + b) / 3;
    min = Math.min(min, luminance); max = Math.max(max, luminance);
    if (high - low < 12) {
      neutral++;
      grayBins[Math.floor((r + g + b) / 3 / 8)]++;
    }
  }
  // Adjacent bins avoid missing a gray background straddling a bin boundary.
  const dominantGray = Math.max(...grayBins.map((n, i) => n + (grayBins[i + 1] ?? 0)));
  return transparent / count < 0.02 && neutral / count < 0.96 && dominantGray / count < 0.65 && max - min > 6;
}

export interface PlotTexture { url: string; minZoom: number; maxZoom: number }

export async function composePlotTexture(g: PlotGeometry, signal: AbortSignal): Promise<PlotTexture | null> {
  const grid = tileGrid(g);
  const output = document.createElement("canvas");
  const longest = Math.max(g.width, g.height);
  if (!Number.isFinite(longest) || longest <= 0) return null;
  output.width = Math.max(1, Math.round(1024 * g.width / longest));
  output.height = Math.max(1, Math.round(1024 * g.height / longest));
  const ctx = output.getContext("2d");
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
  const cache = new Map<string, Promise<ImageBitmap | null>>();
  const bitmaps = new Set<ImageBitmap>();
  let requests = 0;

  const availability = new Map<number, Promise<{ top: number; left: number; width: number; height: number; data: number[] } | null>>();
  function coverage(z: number) {
    let promise = availability.get(z);
    if (promise) return promise;
    promise = (async () => {
      const factor = 2 ** (grid.zoom - z);
      const top = Math.floor(grid.top / factor), left = Math.floor(grid.left / factor);
      const width = Math.floor(grid.right / factor) - left + 1, height = Math.floor(grid.bottom / factor) - top + 1;
      if (deadline.aborted || requests++ >= 100) return null;
      try {
        const res = await fetch(`${ESRI}/tilemap/${z}/${top}/${left}/${width}/${height}`, {
          mode: "cors", signal: AbortSignal.any([deadline, AbortSignal.timeout(1200)]),
        });
        if (!res.ok) return null;
        const json = await res.json();
        // Adjusted regions have their own location; never index them as the
        // requested block. Unknown metadata falls back to checked tile fetches.
        if (json.adjusted || json.valid === false || !Array.isArray(json.data)
          || json.data.length !== width * height || !json.data.every((v: unknown) => v === 0 || v === 1)) return null;
        return { top, left, width, height, data: json.data as number[] };
      } catch { return null; }
    })();
    availability.set(z, promise);
    return promise;
  }

  function load(z: number, x: number, y: number): Promise<ImageBitmap | null> {
    const key = `${z}/${y}/${x}`;
    const cached = cache.get(key);
    if (cached) return cached;
    if (deadline.aborted) return Promise.resolve(null);
    const work = (async () => {
      let bitmap: ImageBitmap | undefined;
      try {
        const available = await coverage(z);
        if (available && available.data[(y - available.top) * available.width + x - available.left] === 0) return null;
        if (deadline.aborted || requests++ >= 100) return null;
        const res = await fetch(`${ESRI}/tile/${key}?blankTile=false`, {
          mode: "cors", signal: AbortSignal.any([deadline, AbortSignal.timeout(1800)]),
        });
        if (!res.ok) return null;
        bitmap = await createImageBitmap(await res.blob());
        if (bitmap.width !== 256 || bitmap.height !== 256) { bitmap.close(); return null; }
        const probe = document.createElement("canvas");
        probe.width = probe.height = 64;
        const pixels = probe.getContext("2d", { willReadFrequently: true });
        if (!pixels) { bitmap.close(); return null; }
        pixels.drawImage(bitmap, 0, 0, 64, 64);
        if (!hasImageryPixels(pixels.getImageData(0, 0, 64, 64).data)) { bitmap.close(); return null; }
        bitmaps.add(bitmap);
        return bitmap;
      } catch {
        bitmap?.close(); // Decode errors, CORS/tainted pixels, timeout: never display unchecked images.
        return null;
      }
    })();
    cache.set(key, work);
    return work;
  }

  const tiles: { x: number; y: number }[] = [];
  for (let y = grid.top; y <= grid.bottom; y++) for (let x = grid.left; x <= grid.right; x++) tiles.push({ x, y });
  let cursor = 0, failed = false, minZoom = grid.zoom, maxZoom = 0;
  async function worker() {
    while (cursor < tiles.length && !deadline.aborted) {
      const { x, y } = tiles[cursor++];
      let found = false;
      // Every child resolves independently, preserving detail at coverage edges.
      // Parent promises are shared, so siblings never refetch the same ancestor.
      for (let z = grid.zoom; z >= Math.max(0, grid.zoom - 8) && !deadline.aborted; z--) {
        const levels = grid.zoom - z, factor = 2 ** levels;
        const bitmap = await load(z, Math.floor(x / factor), Math.floor(y / factor));
        if (!bitmap || deadline.aborted) continue;
        const crop = ancestorCrop(x, y, levels);
        const n = 2 ** grid.zoom;
        ctx!.drawImage(bitmap, crop.x, crop.y, crop.size, crop.size,
          (x / n - g.west) / g.width * output.width,
          (y / n - g.north) / g.height * output.height,
          output.width / (n * g.width), output.height / (n * g.height));
        minZoom = Math.min(minZoom, z); maxZoom = Math.max(maxZoom, z);
        found = true;
        break;
      }
      if (!found) failed = true;
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(6, tiles.length) }, worker));
    // Publish atomically: no gray holes, half-loaded mosaics or placeholder flash.
    if (failed || deadline.aborted || cursor < tiles.length) return null;
    return { url: output.toDataURL("image/jpeg", 0.92), minZoom, maxZoom };
  } finally {
    bitmaps.forEach((bitmap) => bitmap.close());
  }
}
