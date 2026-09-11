/**
 * HSL recolor helpers for ImageData (browser canvas).
 * Shifts hue across the image while preserving luminance structure.
 */

export type RecolorSettings = {
  hueShift: number; // degrees -180..180
  saturation: number; // 0..200 (100 = original)
  brightness: number; // 0..200 (100 = original)
  /** When true, only recolor pixels above this lightness floor (keeps dark lines). */
  protectShadows: boolean;
};

export const DEFAULT_RECOLOR: RecolorSettings = {
  hueShift: 0,
  saturation: 100,
  brightness: 100,
  protectShadows: true,
};

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  switch (max) {
    case r:
      h = (g - b) / d + (g < b ? 6 : 0);
      break;
    case g:
      h = (b - r) / d + 2;
      break;
    default:
      h = (r - g) / d + 4;
  }
  h /= 6;
  return [h, s, l];
}

function hue2rgb(p: number, q: number, t: number) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ];
}

export function recolorImageData(
  source: ImageData,
  settings: RecolorSettings,
  /** Optional mask: 0 keeps original pixel, >0 applies recolor. Length = width*height. */
  mask?: Uint8Array | null,
): ImageData {
  const out = new ImageData(source.width, source.height);
  const src = source.data;
  const dst = out.data;
  const hueDelta = settings.hueShift / 360;
  const satMul = settings.saturation / 100;
  const briMul = settings.brightness / 100;

  for (let i = 0, p = 0; i < src.length; i += 4, p++) {
    const a = src[i + 3]!;
    dst[i + 3] = a;
    if (a === 0) continue;

    if (mask && mask[p]! === 0) {
      dst[i] = src[i]!;
      dst[i + 1] = src[i + 1]!;
      dst[i + 2] = src[i + 2]!;
      continue;
    }

    let [h, s, l] = rgbToHsl(src[i]!, src[i + 1]!, src[i + 2]!);

    if (settings.protectShadows && l < 0.08) {
      dst[i] = src[i]!;
      dst[i + 1] = src[i + 1]!;
      dst[i + 2] = src[i + 2]!;
      continue;
    }

    h = (h + hueDelta) % 1;
    if (h < 0) h += 1;
    s = Math.min(1, Math.max(0, s * satMul));
    l = Math.min(1, Math.max(0, l * briMul));
    const [r, g, b] = hslToRgb(h, s, l);
    dst[i] = r;
    dst[i + 1] = g;
    dst[i + 2] = b;
  }

  return out;
}

export async function blobToPngBytes(blob: Blob): Promise<Uint8Array> {
  const buf = await blob.arrayBuffer();
  return new Uint8Array(buf);
}
