/**
 * Renders the FOUR plot-analysis layers through the production compose code
 * (`composeNdviLayer` / `composeIndexLayer` / `composeTrueColorLayer`) and
 * writes the exact RGBA the overlay <image> paints to docs/plot-view/.
 *
 * This is evidence of the layer PAINT (ramps, clipping, masked transparency,
 * bilinear smoothing) — the fixtures are the SAME synthetic scene the e2e
 * spec `e2e/plot-layers.spec.ts` serves, so these previews match what the
 * browser screenshots will show. It is NOT a browser screenshot: the full-app
 * captures at 360/390/430px come from `npm run test:e2e` (spec committed).
 *
 * Run: node --import ./test/unit/register.mjs tools/render-layer-previews.mts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import {
  composeIndexLayer,
  composeNdviLayer,
  composeTrueColorLayer,
  measuredPixelMask,
  ndviColorDomain,
} from "@/lib/plot/ndvi-layers";
import type { NdviRaster } from "@/lib/field-data/types";
import type { Ring } from "@/lib/geo/polygon";

/* --------------------- one synthetic scene, four layers --------------------- */

const SCENE = "2026-09-25";
const W = 24;
const H = 22;
const BBOX = { west: 5.7194, south: 34.8194, east: 5.7206, north: 34.8206 };
const N = W * H;

// The boundary the display clips to — slightly inside the raster bbox so the
// polygon clip (not just the rectangle) is what shapes the overlay.
const RING: Ring = [
  [BBOX.west + 0.00016, BBOX.south + 0.00016],
  [BBOX.east - 0.00012, BBOX.south + 0.0001],
  [BBOX.east - 0.0001, BBOX.north - 0.0002],
  [BBOX.west + 0.0001, BBOX.north - 0.00014],
];

// Same diagonal cloud band as the e2e fixtures — masked on EVERY layer.
const masked = (i: number) => Math.abs((i % W) - Math.floor(i / W) * 0.6 - 4) < 1.6;

function indexRaster(values: (i: number) => number): NdviRaster {
  const ndvi: (number | null)[] = new Array(N);
  const dataMask: number[] = new Array(N);
  for (let i = 0; i < N; i += 1) {
    const m = masked(i);
    ndvi[i] = m ? null : Number(values(i).toFixed(3));
    dataMask[i] = m ? 0 : 1;
  }
  return { bbox: BBOX, width: W, height: H, resolutionM: 10, ndvi, dataMask };
}

const ndvi = indexRaster((i) => 0.1 + 0.62 * ((i % W) / (W - 1)) + 0.06 * Math.sin(i / 9));
const ndmi = indexRaster((i) => -0.34 + 0.72 * (Math.floor(i / W) / (H - 1)));
const ndre = indexRaster((i) => 0.04 + 0.5 * ((i % W) / (W - 1)));

const trueColor: NdviRaster & { rgb: ([number, number, number] | null)[] } = (() => {
  const base = indexRaster(() => 0); // dataMask comes from the same cloud band
  const rgb: ([number, number, number] | null)[] = new Array(N);
  const ndviVals: (number | null)[] = new Array(N).fill(null); // image layer: no index values
  for (let i = 0; i < N; i += 1) {
    const x = i % W;
    const y = Math.floor(i / W);
    rgb[i] = base.dataMask[i] ? [70 + 4 * x, 96 + 4 * y, 58 + 2 * ((x + y) % 7)] : null;
  }
  return { ...base, ndvi: ndviVals, rgb };
})();

/* ------------------------------- the painting ------------------------------- */

mkdirSync("docs/plot-view", { recursive: true });
// The plot view's night surface, so transparent (masked / outside-polygon)
// pixels read the same way they do in the app.
const BACKDROP = { r: 16, g: 26, b: 22 };

async function save(name: string, composed: { width: number; height: number; data: Uint8ClampedArray }) {
  const flat = Buffer.alloc(composed.width * composed.height * 3);
  for (let i = 0; i < composed.width * composed.height; i += 1) {
    const r = composed.data[i * 4];
    const g = composed.data[i * 4 + 1];
    const b = composed.data[i * 4 + 2];
    const a = composed.data[i * 4 + 3] / 255;
    flat[i * 3] = Math.round(r * a + BACKDROP.r * (1 - a));
    flat[i * 3 + 1] = Math.round(g * a + BACKDROP.g * (1 - a));
    flat[i * 3 + 2] = Math.round(b * a + BACKDROP.b * (1 - a));
  }
  const png = await sharp(flat, { raw: { width: composed.width, height: composed.height, channels: 3 } })
    .png()
    .toBuffer();
  writeFileSync(`docs/plot-view/${name}.png`, png);
  console.log(`docs/plot-view/${name}.png  (${composed.width}x${composed.height})`);
}

const domainOf = (raster: NdviRaster): readonly [number, number] => {
  const domain = ndviColorDomain(raster);
  if (!domain) throw new Error("fixture produced an empty domain");
  return domain;
};

const ndviMask = measuredPixelMask(RING, ndvi);

await save("preview-layer-ndvi", composeNdviLayer(ndvi, ndviMask, domainOf(ndvi)));

for (const [id, raster] of [
  ["ndmi", ndmi],
  ["ndre", ndre],
] as const) {
  const mask = measuredPixelMask(RING, raster);
  await save(`preview-layer-${id}`, composeIndexLayer(id, raster, mask, domainOf(raster)));
}

await save("preview-layer-truecolor", composeTrueColorLayer(trueColor, measuredPixelMask(RING, trueColor), trueColor.rgb));

console.log(`scene=${SCENE} grid=${W}x${H}@10m — same synthetic scene as e2e/plot-layers.spec.ts`);
