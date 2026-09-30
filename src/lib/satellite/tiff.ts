/**
 * A deliberately small GeoTIFF *pixel* reader for the one file this app asks
 * the Sentinel Hub Process API for: a FLOAT32 raster of a few thousand pixels.
 *
 * It reads pixels only — georeferencing is not needed, because the request's
 * bbox and pixel size are ours, so pixel (x, y) → lon/lat is computed from the
 * request (see `sentinelhub.ts`). Pulling in a full GeoTIFF library for ~70×70
 * floats would cost far more bundle and cold-start time than these ~150 lines.
 *
 * Supported: classic TIFF (little- or big-endian), strips or tiles, chunky or
 * planar layout, compression none / Deflate (8 and 32946), predictor 1 and 3
 * (floating-point), 32-bit IEEE float samples. Anything else throws a
 * `TiffError`, which the caller reports as a "malformed" answer — never as a
 * guessed number.
 */

import { inflateSync } from "node:zlib";

export class TiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TiffError";
  }
}

export interface DecodedTiff {
  width: number;
  height: number;
  /** One row-major `Float32Array` (length `width × height`) per sample/band. */
  bands: Float32Array[];
}

const TAG = {
  width: 256,
  height: 257,
  bitsPerSample: 258,
  compression: 259,
  stripOffsets: 273,
  samplesPerPixel: 277,
  rowsPerStrip: 278,
  stripByteCounts: 279,
  planar: 284,
  predictor: 317,
  tileWidth: 322,
  tileLength: 323,
  tileOffsets: 324,
  tileByteCounts: 325,
  sampleFormat: 339,
} as const;

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 6: 1, 7: 1, 8: 2, 9: 4, 11: 4, 12: 8, 16: 8 };

export function decodeFloatTiff(input: Uint8Array): DecodedTiff {
  if (input.byteLength < 16) throw new TiffError("file too short");
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const order = String.fromCharCode(input[0], input[1]);
  if (order !== "II" && order !== "MM") throw new TiffError("not a TIFF (bad byte-order mark)");
  const little = order === "II";
  const magic = view.getUint16(2, little);
  if (magic === 43) throw new TiffError("BigTIFF is not supported");
  if (magic !== 42) throw new TiffError("not a TIFF (bad magic number)");

  const ifdOffset = view.getUint32(4, little);
  if (ifdOffset + 2 > input.byteLength) throw new TiffError("IFD offset out of range");
  const entryCount = view.getUint16(ifdOffset, little);
  const tags = new Map<number, number[]>();
  for (let i = 0; i < entryCount; i += 1) {
    const at = ifdOffset + 2 + i * 12;
    if (at + 12 > input.byteLength) throw new TiffError("IFD truncated");
    const tag = view.getUint16(at, little);
    const type = view.getUint16(at + 2, little);
    const count = view.getUint32(at + 4, little);
    const size = TYPE_SIZE[type];
    if (!size) continue;
    const total = size * count;
    const dataAt = total <= 4 ? at + 8 : view.getUint32(at + 8, little);
    if (dataAt + total > input.byteLength) throw new TiffError(`tag ${tag} points outside the file`);
    const values: number[] = [];
    for (let k = 0; k < count; k += 1) {
      const p = dataAt + k * size;
      if (type === 3) values.push(view.getUint16(p, little));
      else if (type === 4) values.push(view.getUint32(p, little));
      else if (type === 1 || type === 7) values.push(view.getUint8(p));
      else continue; // ASCII/rational/etc. carry nothing this decoder needs.
    }
    tags.set(tag, values);
  }

  const one = (tag: number, fallback?: number): number => {
    const v = tags.get(tag)?.[0];
    if (v !== undefined) return v;
    if (fallback !== undefined) return fallback;
    throw new TiffError(`missing tag ${tag}`);
  };

  const width = one(TAG.width);
  const height = one(TAG.height);
  const samples = one(TAG.samplesPerPixel, 1);
  const compression = one(TAG.compression, 1);
  const planar = one(TAG.planar, 1);
  const predictor = one(TAG.predictor, 1);
  if (width < 1 || height < 1 || width * height > 25_000_000) throw new TiffError("implausible raster size");
  if (samples < 1 || samples > 8) throw new TiffError("unsupported sample count");

  const bits = tags.get(TAG.bitsPerSample) ?? [1];
  const formats = tags.get(TAG.sampleFormat) ?? [1];
  if (!bits.every((b) => b === 32) || !formats.every((f) => f === 3)) {
    throw new TiffError("only 32-bit float samples are supported");
  }
  if (compression !== 1 && compression !== 8 && compression !== 32946) {
    throw new TiffError(`unsupported compression ${compression}`);
  }
  if (predictor !== 1 && predictor !== 3) throw new TiffError(`unsupported predictor ${predictor}`);

  const tiled = tags.has(TAG.tileOffsets);
  const offsets = tags.get(tiled ? TAG.tileOffsets : TAG.stripOffsets);
  const counts = tags.get(tiled ? TAG.tileByteCounts : TAG.stripByteCounts);
  if (!offsets || !counts || offsets.length !== counts.length) throw new TiffError("missing strip/tile table");

  const blockW = tiled ? one(TAG.tileWidth) : width;
  const blockH = tiled ? one(TAG.tileLength) : Math.min(one(TAG.rowsPerStrip, height), height);
  const across = Math.ceil(width / blockW);
  const down = Math.ceil(height / blockH);
  const perPlane = across * down;
  const planes = planar === 2 ? samples : 1;
  if (offsets.length < perPlane * planes) throw new TiffError("strip/tile table too short");
  const samplesInBlock = planar === 2 ? 1 : samples;

  const bands = Array.from({ length: samples }, () => new Float32Array(width * height));

  for (let plane = 0; plane < planes; plane += 1) {
    for (let by = 0; by < down; by += 1) {
      for (let bx = 0; bx < across; bx += 1) {
        const index = plane * perPlane + by * across + bx;
        const start = offsets[index];
        const length = counts[index];
        if (start + length > input.byteLength) throw new TiffError("block points outside the file");
        let block: Uint8Array = input.subarray(start, start + length);
        if (compression !== 1) {
          try {
            block = new Uint8Array(inflateSync(block));
          } catch {
            throw new TiffError("corrupt Deflate block");
          }
        }
        // Strips on the last row band hold fewer rows than `blockH`.
        const rows = tiled ? blockH : Math.min(blockH, height - by * blockH);
        const rowValues = blockW * samplesInBlock;
        const rowBytes = rowValues * 4;
        if (block.byteLength < rows * rowBytes) throw new TiffError("block smaller than its raster");

        const scratch = new DataView(new ArrayBuffer(4));
        for (let r = 0; r < rows; r += 1) {
          const row = block.subarray(r * rowBytes, (r + 1) * rowBytes);
          // Floating-point predictor: undo byte-wise delta coding, then the
          // bytes of every value sit in MSB-first planes across the row.
          let values: (i: number) => number;
          if (predictor === 3) {
            const fixed = new Uint8Array(row);
            for (let i = samplesInBlock; i < fixed.length; i += 1) fixed[i] = (fixed[i] + fixed[i - samplesInBlock]) & 0xff;
            values = (i) => {
              for (let b = 0; b < 4; b += 1) scratch.setUint8(b, fixed[b * rowValues + i]);
              return scratch.getFloat32(0, false);
            };
          } else {
            const rv = new DataView(row.buffer, row.byteOffset, row.byteLength);
            values = (i) => rv.getFloat32(i * 4, little);
          }
          const y = by * blockH + r;
          if (y >= height) break;
          for (let x = 0; x < blockW; x += 1) {
            const px = bx * blockW + x;
            if (px >= width) break;
            for (let s = 0; s < samplesInBlock; s += 1) {
              bands[planar === 2 ? plane : s][y * width + px] = values(x * samplesInBlock + s);
            }
          }
        }
      }
    }
  }
  return { width, height, bands };
}
