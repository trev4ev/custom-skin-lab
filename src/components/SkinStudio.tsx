"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CHAMPIONS,
  defaultTexturePath,
  textureForSubmesh,
  type ChampionOption,
  type ChampionTexture,
} from "@/lib/champions";
import {
  DEFAULT_RECOLOR,
  type RecolorSettings,
} from "@/lib/recolor";
import {
  composeRecolorEdits,
  createTextureEditStore,
  settingsForScope,
  writeScopeSettings,
  type EditScope,
  type TextureEditStore,
} from "@/lib/recolor-edits";
import { fetchSkn } from "@/lib/skn";
import {
  buildIslandIndex,
  drawUvOverlay,
  hitTestIsland,
  islandsForSubmesh,
  islandsSharingUv,
  type IslandIndex,
} from "@/lib/uv-islands";
import { ModelViewer } from "@/components/ModelViewer";
import { packModpkg, slugify } from "@/lib/modpkg/pack";

type Selection =
  | null
  | { type: "submesh"; name: string }
  | { type: "island"; id: number; submeshName: string };

function scopeFromSelection(selection: Selection): EditScope {
  if (!selection) return { type: "texture" };
  if (selection.type === "submesh") return { type: "submesh", name: selection.name };
  return {
    type: "island",
    id: selection.id,
    submeshName: selection.submeshName,
  };
}

function fileToImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not load image"));
    };
    img.src = url;
  });
}

function urlToImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load texture: ${url}`));
    img.src = url;
  });
}

function canvasToPngBase64(canvas: HTMLCanvasElement): string {
  const dataUrl = canvas.toDataURL("image/png");
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

export function SkinStudio() {
  const [championId, setChampionId] = useState(CHAMPIONS[0]!.id);
  const [skinName, setSkinName] = useState("Ember Recolor");
  const [author, setAuthor] = useState("");
  const [texturePath, setTexturePath] = useState(defaultTexturePath(CHAMPIONS[0]!));
  const [settings, setSettings] = useState<RecolorSettings>(DEFAULT_RECOLOR);
  const [hasImage, setHasImage] = useState(false);
  const [loadingTexture, setLoadingTexture] = useState(false);
  const [loadingMesh, setLoadingMesh] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [showOverlay, setShowOverlay] = useState(true);
  const [islandIndex, setIslandIndex] = useState<IslandIndex | null>(null);
  const [activeSubmesh, setActiveSubmesh] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [hoveredIslandId, setHoveredIslandId] = useState<number | null>(null);
  const [modelRevision, setModelRevision] = useState(0);

  const sourceRef = useRef<ImageData | null>(null);
  /** Original ImageData per export path (for re-applying settings). */
  const sourcesByPathRef = useRef<Map<string, ImageData>>(new Map());
  /** Baked preview ImageData when leaving a texture so edits survive switches. */
  const bakedByPathRef = useRef<Map<string, ImageData>>(new Map());
  const activeTextureRef = useRef<ChampionTexture | null>(null);
  /** When true, skip applyRecolor once so a restored baked preview isn't wiped. */
  const holdPreviewRef = useRef(false);
  const sourceCanvasRef = useRef<HTMLCanvasElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const didInit = useRef(false);
  /** Bumped on every champion switch so in-flight loads can't clobber newer state. */
  const loadGenRef = useRef(0);
  /** Sparse recolor edits per texture export path. */
  const editsByPathRef = useRef<Map<string, TextureEditStore>>(new Map());
  /** Cached raster masks keyed by `${w}x${h}:${scopeKey}`. */
  const maskCacheRef = useRef<Map<string, Uint8Array>>(new Map());
  const [editRevision, setEditRevision] = useState(0);

  const champion = useMemo(
    () => CHAMPIONS.find((c) => c.id === championId) ?? CHAMPIONS[0]!,
    [championId],
  );

  const submeshNames = useMemo(() => {
    if (!islandIndex) return [] as string[];
    return islandIndex.mesh.submeshes.map((s) => s.name);
  }, [islandIndex]);

  const activeIslands = useMemo(() => {
    if (!islandIndex || !activeSubmesh) return [];
    return islandsForSubmesh(islandIndex, activeSubmesh);
  }, [islandIndex, activeSubmesh]);

  const getEditStore = useCallback((exportPath: string): TextureEditStore => {
    let store = editsByPathRef.current.get(exportPath);
    if (!store) {
      store = createTextureEditStore();
      editsByPathRef.current.set(exportPath, store);
    }
    return store;
  }, []);

  const redrawOverlay = useCallback(() => {
    const overlay = overlayCanvasRef.current;
    const preview = previewCanvasRef.current;
    if (!overlay || !preview || !islandIndex) return;
    overlay.width = preview.width;
    overlay.height = preview.height;
    const ctx = overlay.getContext("2d");
    if (!ctx) return;
    if (!showOverlay) {
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      return;
    }
    drawUvOverlay(ctx, islandIndex, overlay.width, overlay.height, {
      submeshFilter: activeSubmesh,
      selectedIslandId: selection?.type === "island" ? selection.id : null,
      hoveredIslandId,
      // Only mark submesh-selected when that is the actual selection scope.
      // Using activeSubmesh here painted every island blue and hid hover.
      selectedSubmesh: selection?.type === "submesh" ? selection.name : null,
    });
  }, [islandIndex, showOverlay, activeSubmesh, selection, hoveredIslandId]);

  const applyRecolor = useCallback(() => {
    if (holdPreviewRef.current) {
      holdPreviewRef.current = false;
      setModelRevision((n) => n + 1);
      return;
    }
    const source = sourceRef.current;
    const preview = previewCanvasRef.current;
    const tex = activeTextureRef.current;
    if (!source || !preview || !tex) return;
    const ctx = preview.getContext("2d");
    if (!ctx) return;
    const store = getEditStore(tex.exportPath);
    const result = composeRecolorEdits(
      source,
      store,
      islandIndex,
      maskCacheRef.current,
    );
    ctx.putImageData(result, 0, 0);
    bakedByPathRef.current.set(tex.exportPath, result);
    setModelRevision((n) => n + 1);
  }, [getEditStore, islandIndex, editRevision]);

  const syncSettingsFromStore = useCallback(() => {
    const tex = activeTextureRef.current;
    if (!tex) {
      setSettings(DEFAULT_RECOLOR);
      return;
    }
    const store = getEditStore(tex.exportPath);
    setSettings(settingsForScope(store, scopeFromSelection(selection)));
  }, [getEditStore, selection]);

  const commitSettings = useCallback(
    (next: RecolorSettings) => {
      setSettings(next);
      const tex = activeTextureRef.current;
      if (!tex) return;
      writeScopeSettings(
        getEditStore(tex.exportPath),
        scopeFromSelection(selection),
        next,
        islandIndex,
      );
      setEditRevision((n) => n + 1);
    },
    [getEditStore, selection, islandIndex],
  );

  // Keep sliders in sync with the active scope's stored values.
  useEffect(() => {
    syncSettingsFromStore();
  }, [syncSettingsFromStore, texturePath]);

  useEffect(() => {
    applyRecolor();
    redrawOverlay();
  }, [applyRecolor, redrawOverlay]);

  const bakeCurrentPreview = useCallback(() => {
    const preview = previewCanvasRef.current;
    const tex = activeTextureRef.current;
    if (!preview || !tex) return;
    const ctx = preview.getContext("2d");
    if (!ctx) return;
    bakedByPathRef.current.set(
      tex.exportPath,
      ctx.getImageData(0, 0, preview.width, preview.height),
    );
  }, []);

  const paintImageData = useCallback((image: ImageData) => {
    const sourceCanvas = sourceCanvasRef.current;
    const previewCanvas = previewCanvasRef.current;
    const overlayCanvas = overlayCanvasRef.current;
    if (!sourceCanvas || !previewCanvas) return;

    sourceCanvas.width = image.width;
    sourceCanvas.height = image.height;
    previewCanvas.width = image.width;
    previewCanvas.height = image.height;
    if (overlayCanvas) {
      overlayCanvas.width = image.width;
      overlayCanvas.height = image.height;
    }

    const ctx = sourceCanvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.putImageData(image, 0, 0);
    sourceRef.current = image;
    setHasImage(true);
  }, []);

  const paintImage = useCallback(
    async (img: HTMLImageElement, tex: ChampionTexture) => {
      const sourceCanvas = sourceCanvasRef.current;
      if (!sourceCanvas) return;
      sourceCanvas.width = img.width;
      sourceCanvas.height = img.height;
      const ctx = sourceCanvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.clearRect(0, 0, img.width, img.height);
      ctx.drawImage(img, 0, 0);
      const image = ctx.getImageData(0, 0, img.width, img.height);
      sourcesByPathRef.current.set(tex.exportPath, image);
      activeTextureRef.current = tex;
      setTexturePath(tex.exportPath);
      paintImageData(image);
    },
    [paintImageData],
  );

  const switchToTexture = useCallback(
    async (tex: ChampionTexture, opts?: { restoreBaked?: boolean }) => {
      const current = activeTextureRef.current;
      if (current && current.exportPath === tex.exportPath) {
        setTexturePath(tex.exportPath);
        return;
      }
      bakeCurrentPreview();

      const cachedSource = sourcesByPathRef.current.get(tex.exportPath);
      if (cachedSource) {
        activeTextureRef.current = tex;
        setTexturePath(tex.exportPath);
        paintImageData(cachedSource);
        const baked =
          opts?.restoreBaked === false
            ? null
            : bakedByPathRef.current.get(tex.exportPath);
        // Prefer live compose from the edit store so island/submesh values stay correct.
        holdPreviewRef.current = false;
        setEditRevision((n) => n + 1);
        return;
      }

      setLoadingTexture(true);
      try {
        const img = await urlToImage(tex.url);
        await paintImage(img, tex);
      } finally {
        setLoadingTexture(false);
      }
    },
    [bakeCurrentPreview, paintImage, paintImageData],
  );

  const loadMesh = useCallback(async (next: ChampionOption, gen: number) => {
    if (!next.sknUrl) {
      if (loadGenRef.current !== gen) return;
      setIslandIndex(null);
      setActiveSubmesh(null);
      setSelection(null);
      return;
    }
    setLoadingMesh(true);
    try {
      const mesh = await fetchSkn(next.sknUrl);
      if (loadGenRef.current !== gen) return;
      const index = buildIslandIndex(mesh);
      maskCacheRef.current.clear();
      setIslandIndex(index);
      const preferred =
        mesh.submeshes.find((s) => /body/i.test(s.name))?.name ??
        mesh.submeshes[0]?.name ??
        null;
      setActiveSubmesh(preferred);
      setSelection(preferred ? { type: "submesh", name: preferred } : null);
      const tex = textureForSubmesh(next, preferred);
      const extra = Object.keys(next.submeshTextures).length;
      setStatus(
        `Loaded ${mesh.submeshes.length} submeshes / ${index.islands.length} UV islands` +
          (extra ? ` · ${extra} with alternate textures` : "") +
          `. Click an island to edit it.`,
      );
      await switchToTexture(tex);
    } catch (err) {
      if (loadGenRef.current !== gen) return;
      setIslandIndex(null);
      setActiveSubmesh(null);
      setSelection(null);
      setError(err instanceof Error ? err.message : "Failed to load mesh UVs");
    } finally {
      if (loadGenRef.current === gen) setLoadingMesh(false);
    }
  }, [switchToTexture]);

  const loadStarterTexture = useCallback(
    async (next: ChampionOption, gen: number) => {
      if (loadGenRef.current !== gen) return;
      setLoadingTexture(true);
      setError(null);
      sourcesByPathRef.current.clear();
      bakedByPathRef.current.clear();
      editsByPathRef.current.clear();
      maskCacheRef.current.clear();
      activeTextureRef.current = null;
      setSettings(DEFAULT_RECOLOR);
      setEditRevision((n) => n + 1);
      try {
        const tex = next.defaultTexture;
        const img = await urlToImage(tex.url);
        if (loadGenRef.current !== gen) return;
        await paintImage(img, tex);
        if (loadGenRef.current !== gen) return;
        await loadMesh(next, gen);
      } catch (err) {
        if (loadGenRef.current !== gen) return;
        setHasImage(false);
        setError(err instanceof Error ? err.message : "Failed to load starter texture");
      } finally {
        if (loadGenRef.current === gen) setLoadingTexture(false);
      }
    },
    [paintImage, loadMesh],
  );

  const selectSubmesh = useCallback(
    async (name: string) => {
      const tex = textureForSubmesh(champion, name);
      const swapped =
        activeTextureRef.current?.exportPath !== tex.exportPath
          ? ` · showing ${tex.exportPath.split("/").pop()}`
          : "";
      await switchToTexture(tex);
      setActiveSubmesh(name);
      setSelection({ type: "submesh", name });
      setStatus(`Selected submesh ${name}${swapped}. Click an island to narrow.`);
    },
    [champion, switchToTexture],
  );

  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    const gen = ++loadGenRef.current;
    void loadStarterTexture(CHAMPIONS[0]!, gen);
  }, [loadStarterTexture]);

  function selectChampion(next: ChampionOption) {
    const gen = ++loadGenRef.current;
    setChampionId(next.id);
    setTexturePath(defaultTexturePath(next));
    // Drop previous champion's mesh immediately so the viewer can't pair
    // the new champion's textures with the old geometry while loading.
    setIslandIndex(null);
    setActiveSubmesh(null);
    setSelection(null);
    setHoveredIslandId(null);
    setLoadingMesh(!!next.sknUrl);
    setStatus(`Loading ${next.name}…`);
    void loadStarterTexture(next, gen);
  }

  async function onUpload(file: File | undefined) {
    if (!file) return;
    setError(null);
    setStatus(null);
    try {
      const img = await fileToImage(file);
      const current = activeTextureRef.current ?? champion.defaultTexture;
      const nextPath = file.name
        ? (() => {
            const base = file.name.replace(/\.[^.]+$/, "");
            const folder = current.exportPath.includes("/")
              ? current.exportPath.slice(0, current.exportPath.lastIndexOf("/") + 1)
              : "";
            return `${folder}${base}.png`;
          })()
        : current.exportPath;
      const tex: ChampionTexture = { url: current.url, exportPath: nextPath };
      bakeCurrentPreview();
      editsByPathRef.current.set(nextPath, createTextureEditStore());
      maskCacheRef.current.clear();
      await paintImage(img, tex);
      holdPreviewRef.current = false;
      setEditRevision((n) => n + 1);
      redrawOverlay();
      setStatus(`Using uploaded texture: ${file.name}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    }
  }

  function onPreviewClick(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!islandIndex) return;
    const uv = canvasUvFromEvent(e);
    if (!uv) return;

    const hit = hitTestIsland(islandIndex, uv.u, uv.v, activeSubmesh);
    if (hit) {
      setSelection({ type: "island", id: hit.id, submeshName: hit.submeshName });
      setActiveSubmesh(hit.submeshName);
      setHoveredIslandId(hit.id);
      setStatus(
        (() => {
          const linked = islandsSharingUv(islandIndex, hit.id).length;
          return linked > 1
            ? `Selected island #${hit.id} in ${hit.submeshName} (${hit.faceCount} faces) · ${linked} mesh pieces share this UV.`
            : `Selected island #${hit.id} in ${hit.submeshName} (${hit.faceCount} faces). Edits apply only here.`;
        })(),
      );
      void switchToTexture(textureForSubmesh(champion, hit.submeshName));
    } else if (activeSubmesh) {
      setSelection({ type: "submesh", name: activeSubmesh });
      setStatus(`No island under cursor — editing whole ${activeSubmesh} submesh.`);
    }
  }

  function canvasUvFromEvent(e: React.MouseEvent<HTMLCanvasElement>) {
    // Events fire on the overlay; UV space matches the preview bitmap underneath.
    const bitmap = previewCanvasRef.current;
    const target = e.currentTarget;
    if (!bitmap || !target) return null;
    const rect = target.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    const u = (e.clientX - rect.left) / rect.width;
    const v = (e.clientY - rect.top) / rect.height;
    return {
      u: Math.min(1, Math.max(0, u)),
      v: Math.min(1, Math.max(0, v)),
    };
  }

  function onPreviewMove(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!islandIndex) return;
    const uv = canvasUvFromEvent(e);
    if (!uv) return;
    const hit = hitTestIsland(islandIndex, uv.u, uv.v, activeSubmesh);
    setHoveredIslandId(hit?.id ?? null);
  }

  function onPreviewLeave() {
    setHoveredIslandId(null);
  }

  function onModelHoverIsland(islandId: number | null) {
    setHoveredIslandId(islandId);
  }

  function onModelSelectIsland(islandId: number) {
    if (!islandIndex) return;
    const island = islandIndex.islands.find((i) => i.id === islandId);
    if (!island) return;
    setSelection({ type: "island", id: island.id, submeshName: island.submeshName });
    setActiveSubmesh(island.submeshName);
    setHoveredIslandId(island.id);
    const linked = islandsSharingUv(islandIndex, island.id).length;
    setStatus(
      linked > 1
        ? `Selected island #${island.id} in ${island.submeshName} (${island.faceCount} faces) · ${linked} mesh pieces share this UV.`
        : `Selected island #${island.id} in ${island.submeshName} (${island.faceCount} faces). Edits apply only here.`,
    );
    void switchToTexture(textureForSubmesh(champion, island.submeshName));
  }


  const selectedIslandId =
    selection?.type === "island" ? selection.id : null;

  const selectedSharedIds = useMemo(() => {
    if (!islandIndex || selection?.type !== "island") return null;
    return new Set(islandsSharingUv(islandIndex, selection.id).map((i) => i.id));
  }, [islandIndex, selection]);

  const hoveredSharedIds = useMemo(() => {
    if (!islandIndex || hoveredIslandId == null) return null;
    return new Set(islandsSharingUv(islandIndex, hoveredIslandId).map((i) => i.id));
  }, [islandIndex, hoveredIslandId]);


  function imageDataToPngBase64(image: ImageData): string {
    const c = document.createElement("canvas");
    c.width = image.width;
    c.height = image.height;
    c.getContext("2d")!.putImageData(image, 0, 0);
    return canvasToPngBase64(c);
  }

  async function onExport() {
    const preview = previewCanvasRef.current;
    if (!preview || !hasImage) {
      setError("Load a texture before exporting.");
      return;
    }
    setExporting(true);
    setError(null);
    try {
      holdPreviewRef.current = false;
      applyRecolor();
      bakeCurrentPreview();

      const textures: { path: string; dataBase64: string }[] = [];
      const seen = new Set<string>();
      for (const [path, image] of bakedByPathRef.current) {
        textures.push({ path, dataBase64: imageDataToPngBase64(image) });
        seen.add(path);
      }
      if (!seen.has(texturePath)) {
        textures.push({ path: texturePath, dataBase64: canvasToPngBase64(preview) });
      }

      const thumb =
        textures.find((t) => t.path === champion.defaultTexture.exportPath)?.dataBase64 ??
        textures[0]!.dataBase64;

      const displayName = skinName.trim() || "Recolor";
      const name =
        slugify(`${champion.id}-${displayName}`) || `skin-${Date.now()}`;
      const authorName = author.trim() || "Custom Skin Lab";

      const decodeBase64 = (b64: string) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
      };

      const modpkg = await packModpkg({
        metadata: {
          schema_version: 3,
          name,
          display_name: displayName,
          description: `Recolored ${champion.name} skin generated with Custom Skin Lab.`,
          version: "1.0.0",
          authors: [{ name: authorName, role: "creator" }],
          license: { type: "none" },
          tags: ["champion-skin", "recolor"],
          champions: [champion.id],
          maps: [],
          layers: [{ name: "base", priority: 0, description: "Base layer" }],
        },
        chunks: textures.map((t) => ({
          path: t.path.replace(/^\/+/, ""),
          wad: champion.wad,
          layer: "base",
          data: decodeBase64(t.dataBase64),
        })),
        readme: `# ${displayName}

Champion: ${champion.name}
Generated by Custom Skin Lab

## Install
1. Open League Toolkit Manager
2. Import this \`.modpkg\`
3. Enable the mod and launch League
`,
        thumbnail: decodeBase64(thumb),
      });

      const filename = `${name}_1.0.0.modpkg`;
      const blob = new Blob([modpkg.slice().buffer], {
        type: "application/octet-stream",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      setStatus(
        `Downloaded ${filename} (${textures.length} texture${textures.length === 1 ? "" : "s"}). Import it in League Toolkit Manager.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  const selectionLabel = !selection
    ? "Entire texture"
    : selection.type === "submesh"
      ? `Submesh: ${selection.name}`
      : `Island #${selection.id} (${selection.submeshName})`;

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-8 px-6 py-10 md:px-8 md:py-14">
      <header className="flex flex-col gap-3">
        <p className="text-sm font-medium tracking-[0.2em] text-copper uppercase">
          Custom Skin Lab
        </p>
        <h1 className="max-w-2xl font-display text-4xl leading-tight text-ink md:text-5xl">
          Recolor islands. Export a playable `.modpkg`.
        </h1>
        <p className="max-w-2xl text-base leading-relaxed text-ink/70">
          Pick a submesh (Body, Tails, …), click a UV island, then recolor only that
          part. Inspect the live result on the bind-pose mesh — drag to orbit.
        </p>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-[200px] flex-col gap-1.5">
          <span className="text-xs font-semibold tracking-wide text-ink/60 uppercase">
            Champion
          </span>
          <select
            value={champion.id}
            onChange={(e) => {
              const next = CHAMPIONS.find((c) => c.id === e.target.value);
              if (next) selectChampion(next);
            }}
            className="field"
          >
            {CHAMPIONS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.sknUrl ? "" : " (no mesh)"}
              </option>
            ))}
          </select>
        </label>
      </div>

      <section className="rounded-2xl border border-ink/10 bg-panel/80 p-5 shadow-soft backdrop-blur md:p-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-xl text-ink">Preview</h2>
              <p className="text-xs text-ink/50">
                {loadingTexture || loadingMesh
                  ? "Loading…"
                  : `Editing: ${selectionLabel} · ${texturePath.split("/").pop()}`}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={loadingTexture}
                onClick={() => {
                  const gen = ++loadGenRef.current;
                  setIslandIndex(null);
                  setActiveSubmesh(null);
                  setSelection(null);
                  setHoveredIslandId(null);
                  setLoadingMesh(!!champion.sknUrl);
                  setStatus(`Loading ${champion.name}…`);
                  void loadStarterTexture(champion, gen);
                }}
                className="rounded-full border border-ink/15 bg-paper px-4 py-2 text-sm font-medium text-ink transition hover:bg-ink/5 disabled:opacity-40"
              >
                Reset to starter
              </button>
              <label className="cursor-pointer rounded-full bg-ink px-4 py-2 text-sm font-medium text-paper transition hover:bg-ink/90">
                Upload texture
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={(e) => void onUpload(e.target.files?.[0])}
                />
              </label>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
            <div className="overflow-hidden rounded-xl border border-ink/10 bg-checker">
              <canvas ref={sourceCanvasRef} className="hidden" />
              <div
                className={`relative mx-auto w-fit max-w-full ${hasImage ? "" : "min-h-[220px] w-full"}`}
              >
                <canvas
                  ref={previewCanvasRef}
                  className="block h-auto max-h-[min(420px,46vh)] max-w-full"
                />
                <canvas
                  ref={overlayCanvasRef}
                  onClick={onPreviewClick}
                  onMouseMove={onPreviewMove}
                  onMouseLeave={onPreviewLeave}
                  className="absolute inset-0 h-full w-full cursor-crosshair"
                />
                {!hasImage && !loadingTexture && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-8 text-center text-sm text-ink/50">
                    Choose a starter champion or upload an extracted texture.
                  </div>
                )}
              </div>
            </div>

            <div>
              <ModelViewer
                mesh={islandIndex?.mesh ?? null}
                champion={champion}
                revision={modelRevision}
                activeExportPath={texturePath}
                previewCanvasRef={previewCanvasRef}
                bakedByPathRef={bakedByPathRef}
                islandIndex={islandIndex}
                hoverIslandId={hoveredIslandId}
                selectedIslandId={selectedIslandId}
                onHoverIsland={onModelHoverIsland}
                onSelectIsland={onModelSelectIsland}
              />
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-ink/80">
              <input
                type="checkbox"
                checked={showOverlay}
                onChange={(e) => setShowOverlay(e.target.checked)}
                className="size-4 accent-copper"
              />
              Show UV overlay
            </label>
            <button
              type="button"
              className="rounded-full border border-ink/15 px-3 py-1.5 text-xs font-medium text-ink/80 hover:bg-ink/5"
              onClick={() => {
                setSelection(null);
                setStatus("Editing entire texture.");
              }}
            >
              Entire texture
            </button>
            {activeSubmesh && (
              <button
                type="button"
                className="rounded-full border border-ink/15 px-3 py-1.5 text-xs font-medium text-ink/80 hover:bg-ink/5"
                onClick={() => void selectSubmesh(activeSubmesh)}
              >
                Whole {activeSubmesh}
              </button>
            )}
          </div>

          {submeshNames.length > 0 && (
            <div className="mt-4">
              <p className="mb-2 text-xs font-semibold tracking-wide text-ink/60 uppercase">
                Level 1 · Submesh
              </p>
              <div className="flex flex-wrap gap-2">
                {submeshNames.map((name) => {
                  const count = islandIndex
                    ? islandsForSubmesh(islandIndex, name).length
                    : 0;
                  const active = activeSubmesh === name;
                  const tex = textureForSubmesh(champion, name);
                  const alt =
                    tex.exportPath !== champion.defaultTexture.exportPath;
                  return (
                    <button
                      key={name}
                      type="button"
                      title={
                        alt
                          ? `Uses ${tex.exportPath.split("/").pop()}`
                          : `Uses default ${champion.defaultTexture.exportPath.split("/").pop()}`
                      }
                      onClick={() => void selectSubmesh(name)}
                      className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                        active
                          ? "bg-copper text-paper"
                          : "border border-ink/15 bg-paper text-ink hover:bg-ink/5"
                      }`}
                    >
                      {name}
                      <span className="ml-1 opacity-70">{count}</span>
                      {alt && <span className="ml-1 opacity-80">↗</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {activeIslands.length > 0 && (
            <div className="mt-4">
              <p className="mb-2 text-xs font-semibold tracking-wide text-ink/60 uppercase">
                Level 2 · UV islands in {activeSubmesh} (click preview or pick below)
              </p>
              <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
                {activeIslands.slice(0, 40).map((island) => {
                  const active = selectedSharedIds?.has(island.id) ?? false;
                  const hovered =
                    !active && (hoveredSharedIds?.has(island.id) ?? false);
                  return (
                    <button
                      key={island.id}
                      type="button"
                      title={`${island.faceCount} faces`}
                      onMouseEnter={() => setHoveredIslandId(island.id)}
                      onMouseLeave={() => setHoveredIslandId(null)}
                      onClick={() => {
                        setSelection({
                          type: "island",
                          id: island.id,
                          submeshName: island.submeshName,
                        });
                        setStatus(
                          (() => {
                            const linked = islandIndex
                              ? islandsSharingUv(islandIndex, island.id).length
                              : 1;
                            return linked > 1
                              ? `Selected island #${island.id} (${island.faceCount} faces) · ${linked} mesh pieces share this UV.`
                              : `Selected island #${island.id} (${island.faceCount} faces).`;
                          })(),
                        );
                      }}
                      className={`rounded-md px-2 py-1 font-mono text-[10px] transition ${
                        active || hovered
                          ? "bg-amber-400 text-ink"
                          : "bg-ink/5 text-ink/70 hover:bg-ink/10"
                      }`}
                    >
                      #{island.id}
                    </button>
                  );
                })}
                {activeIslands.length > 40 && (
                  <span className="px-2 py-1 text-[10px] text-ink/45">
                    +{activeIslands.length - 40} more — click the preview to pick them
                  </span>
                )}
              </div>
            </div>
          )}

          <div className="mt-5 grid gap-4">
            <Slider
              label="Hue shift"
              min={-180}
              max={180}
              value={settings.hueShift}
              suffix="°"
              onChange={(hueShift) => commitSettings({ ...settings, hueShift })}
            />
            <Slider
              label="Saturation"
              min={0}
              max={200}
              value={settings.saturation}
              suffix="%"
              onChange={(saturation) => commitSettings({ ...settings, saturation })}
            />
            <Slider
              label="Brightness"
              min={0}
              max={200}
              value={settings.brightness}
              suffix="%"
              onChange={(brightness) => commitSettings({ ...settings, brightness })}
            />
            <label className="flex items-center gap-2 text-sm text-ink/80">
              <input
                type="checkbox"
                checked={settings.protectShadows}
                onChange={(e) =>
                  commitSettings({ ...settings, protectShadows: e.target.checked })
                }
                className="size-4 accent-copper"
              />
              Protect deep shadows / linework
            </label>
          </div>
        </section>

        <section className="flex flex-col gap-5 rounded-2xl border border-ink/10 bg-panel/80 p-5 shadow-soft backdrop-blur">
          <h2 className="font-display text-xl text-ink">Mod package</h2>

          <Field label="Skin name">
            <input
              className="field"
              value={skinName}
              onChange={(e) => setSkinName(e.target.value)}
              placeholder="Ember Recolor"
            />
          </Field>

          <Field label="Author (optional)">
            <input
              className="field"
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder="Your name"
            />
          </Field>

          <Field label="Texture path inside WAD" hint={`Target archive: ${champion.wad}`}>
            <input
              className="field font-mono text-xs"
              value={texturePath}
              onChange={(e) => setTexturePath(e.target.value)}
            />
          </Field>

          <div className="rounded-xl border border-dashed border-ink/15 bg-ink/[0.03] p-4 text-sm leading-relaxed text-ink/65">
            Selection scope: <span className="text-ink">{selectionLabel}</span>.
            Island edits are remembered when you switch islands; editing a whole
            submesh (or the entire texture) replaces nested island values for that
            scope. Export writes the composed preview.
          </div>

          <button
            type="button"
            disabled={exporting || !hasImage || loadingTexture}
            onClick={() => void onExport()}
            className="mt-auto rounded-full bg-copper px-5 py-3 text-sm font-semibold text-paper transition hover:bg-copper/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {exporting ? "Building .modpkg…" : "Download .modpkg"}
          </button>

          {error && (
            <p className="text-sm text-red-700" role="alert">
              {error}
            </p>
          )}
          {status && (
            <p className="text-sm text-ink/70" role="status">
              {status}
            </p>
          )}
        </section>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-semibold tracking-wide text-ink/60 uppercase">
        {label}
      </span>
      {children}
      {hint && <span className="text-xs text-ink/45">{hint}</span>}
    </label>
  );
}

function Slider({
  label,
  min,
  max,
  value,
  suffix,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  suffix: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="grid gap-2">
      <div className="flex items-center justify-between text-sm">
        <span className="text-ink/70">{label}</span>
        <span className="font-mono text-ink">
          {value}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="accent-copper"
      />
    </label>
  );
}
