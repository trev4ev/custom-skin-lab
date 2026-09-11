import {
  DEFAULT_RECOLOR,
  recolorImageData,
  type RecolorSettings,
} from "@/lib/recolor";
import {
  islandsForSubmesh,
  rasterizeSelectionMask,
  type IslandIndex,
} from "@/lib/uv-islands";

/** Scope currently being edited in the UI. */
export type EditScope =
  | { type: "texture" }
  | { type: "submesh"; name: string }
  | { type: "island"; id: number; submeshName: string };

/**
 * Sparse recolor store for one texture export path.
 * - Island edits are stored only while they differ from default.
 * - A submesh-level write clears island entries for that submesh (one value wins).
 * - A whole-texture write clears submesh + island entries for this texture.
 */
export type TextureEditStore = {
  texture: RecolorSettings | null;
  submeshes: Map<string, RecolorSettings>;
  islands: Map<number, RecolorSettings>;
};

export function createTextureEditStore(): TextureEditStore {
  return {
    texture: null,
    submeshes: new Map(),
    islands: new Map(),
  };
}

export function isDefaultRecolor(settings: RecolorSettings): boolean {
  return (
    settings.hueShift === DEFAULT_RECOLOR.hueShift &&
    settings.saturation === DEFAULT_RECOLOR.saturation &&
    settings.brightness === DEFAULT_RECOLOR.brightness &&
    settings.protectShadows === DEFAULT_RECOLOR.protectShadows
  );
}

function cloneSettings(settings: RecolorSettings): RecolorSettings {
  return { ...settings };
}

/** Settings the sliders should show for the active scope. */
export function settingsForScope(
  store: TextureEditStore,
  scope: EditScope,
): RecolorSettings {
  if (scope.type === "texture") {
    return cloneSettings(store.texture ?? DEFAULT_RECOLOR);
  }
  if (scope.type === "submesh") {
    return cloneSettings(
      store.submeshes.get(scope.name) ?? store.texture ?? DEFAULT_RECOLOR,
    );
  }
  return cloneSettings(
    store.islands.get(scope.id) ??
      store.submeshes.get(scope.submeshName) ??
      store.texture ??
      DEFAULT_RECOLOR,
  );
}

/**
 * Persist slider values for `scope`.
 * Submesh writes clear island entries under that submesh.
 * Texture writes clear everything for this texture store.
 * Island/submesh writes always keep an entry — including an explicit reset
 * to defaults — so they can override a parent scope's recolor.
 */
export function writeScopeSettings(
  store: TextureEditStore,
  scope: EditScope,
  settings: RecolorSettings,
  islandIndex: IslandIndex | null,
): void {
  const next = cloneSettings(settings);

  if (scope.type === "texture") {
    store.submeshes.clear();
    store.islands.clear();
    // Whole-texture default with nothing nested is just "no edits".
    store.texture = isDefaultRecolor(next) ? null : next;
    return;
  }

  // Narrower edits supersede a whole-texture override without keeping both.
  store.texture = null;

  if (scope.type === "submesh") {
    if (islandIndex) {
      for (const island of islandsForSubmesh(islandIndex, scope.name)) {
        store.islands.delete(island.id);
      }
    } else {
      // Fallback: drop all islands if we can't resolve membership.
      store.islands.clear();
    }
    // Keep defaults too — an explicit 0 must override a prior texture edit.
    store.submeshes.set(scope.name, next);
    return;
  }

  // Always persist island values, including explicit resets to default.
  store.islands.set(scope.id, next);
}

/**
 * Apply only masked pixels from `source` into `dest` using `settings`.
 * Unmasked pixels in `dest` are left unchanged. Samples always from `source`
 * so stacked regions don't double-apply hue shifts.
 * Default settings copy source→dest for the mask (explicit reset over a parent).
 */
export function applyRecolorRegion(
  source: ImageData,
  dest: ImageData,
  settings: RecolorSettings,
  mask: Uint8Array,
): void {
  const src = source.data;
  const dst = dest.data;

  if (isDefaultRecolor(settings)) {
    for (let i = 0, p = 0; i < src.length; i += 4, p++) {
      if (mask[p]! === 0) continue;
      dst[i] = src[i]!;
      dst[i + 1] = src[i + 1]!;
      dst[i + 2] = src[i + 2]!;
      dst[i + 3] = src[i + 3]!;
    }
    return;
  }

  const patch = recolorImageData(source, settings, mask);
  const patched = patch.data;
  for (let i = 0, p = 0; i < patched.length; i += 4, p++) {
    if (mask[p]! === 0) continue;
    dst[i] = patched[i]!;
    dst[i + 1] = patched[i + 1]!;
    dst[i + 2] = patched[i + 2]!;
    dst[i + 3] = patched[i + 3]!;
  }
}

function cloneImageData(source: ImageData): ImageData {
  return new ImageData(new Uint8ClampedArray(source.data), source.width, source.height);
}

/**
 * Compose all stored edits for a texture onto the original source.
 * Order: whole-texture → submeshes → islands (later wins on overlap).
 */
export function composeRecolorEdits(
  source: ImageData,
  store: TextureEditStore,
  islandIndex: IslandIndex | null,
  maskCache?: Map<string, Uint8Array>,
): ImageData {
  const out = cloneImageData(source);
  const { width, height } = source;

  const getMask = (
    key: string,
    selection: null | { type: "submesh"; name: string } | { type: "island"; id: number },
  ): Uint8Array => {
    const cacheKey = `${width}x${height}:${key}`;
    const cached = maskCache?.get(cacheKey);
    if (cached) return cached;
    if (!islandIndex) {
      const full = new Uint8Array(width * height);
      full.fill(255);
      maskCache?.set(cacheKey, full);
      return full;
    }
    const mask = rasterizeSelectionMask(islandIndex, width, height, selection);
    maskCache?.set(cacheKey, mask);
    return mask;
  };

  if (store.texture) {
    const mask = getMask("texture", null);
    applyRecolorRegion(source, out, store.texture, mask);
  }

  for (const [name, settings] of store.submeshes) {
    const mask = getMask(`submesh:${name}`, { type: "submesh", name });
    applyRecolorRegion(source, out, settings, mask);
  }

  for (const [id, settings] of store.islands) {
    const mask = getMask(`island:${id}`, { type: "island", id });
    applyRecolorRegion(source, out, settings, mask);
  }

  return out;
}

