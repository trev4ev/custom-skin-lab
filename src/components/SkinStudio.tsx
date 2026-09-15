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
  islandsSharingUv,
  type IslandIndex,
} from "@/lib/uv-islands";
import { ModelViewer } from "@/components/ModelViewer";
import { packModpkg, slugify } from "@/lib/modpkg/pack";

type Selection =
  | null
  | { type: "submesh"; name: string }
  | { type: "island"; ids: number[]; submeshName: string };

function scopeFromSelection(selection: Selection): EditScope {
  if (!selection) return { type: "texture" };
  if (selection.type === "submesh") return { type: "submesh", name: selection.name };
  return {
    type: "island",
    ids: selection.ids,
    submeshName: selection.submeshName,
  };
}

/** True if `islandId` (or any UV-shared sibling) is already in the island selection. */
function selectionHasIsland(
  selection: Selection,
  islandIndex: IslandIndex,
  islandId: number,
): boolean {
  if (selection?.type !== "island") return false;
  const group = new Set(
    islandsSharingUv(islandIndex, islandId).map((i) => i.id),
  );
  return selection.ids.some((id) => group.has(id));
}

function selectIsland(
  selection: Selection,
  islandIndex: IslandIndex,
  island: { id: number; submeshName: string; faceCount: number },
  shiftKey: boolean,
): Selection {
  if (
    shiftKey &&
    selection?.type === "island" &&
    selection.submeshName === island.submeshName
  ) {
    if (selectionHasIsland(selection, islandIndex, island.id)) {
      const group = new Set(
        islandsSharingUv(islandIndex, island.id).map((i) => i.id),
      );
      const nextIds = selection.ids.filter((id) => !group.has(id));
      if (nextIds.length === 0) {
        return { type: "submesh", name: island.submeshName };
      }
      return {
        type: "island",
        ids: nextIds,
        submeshName: selection.submeshName,
      };
    }
    return {
      type: "island",
      ids: [...selection.ids, island.id],
      submeshName: selection.submeshName,
    };
  }
  return {
    type: "island",
    ids: [island.id],
    submeshName: island.submeshName,
  };
}

function islandSelectionStatus(
  islandIndex: IslandIndex,
  selection: Extract<Selection, { type: "island" }>,
): string {
  const count = selection.ids.length;
  if (count > 1) {
    return `Selected ${count} UV islands in ${selection.submeshName}. Edits apply to all.`;
  }
  const id = selection.ids[0]!;
  const island = islandIndex.islands.find((i) => i.id === id);
  const linked = islandsSharingUv(islandIndex, id).length;
  const faces = island?.faceCount ?? 0;
  return linked > 1
    ? `Selected island #${id} in ${selection.submeshName} (${faces} faces) · ${linked} mesh pieces share this UV.`
    : `Selected island #${id} in ${selection.submeshName} (${faces} faces). Edits apply only here.`;
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
  const [textureExpanded, setTextureExpanded] = useState(false);
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
      selectedIslandIds: selection?.type === "island" ? selection.ids : null,
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

  useEffect(() => {
    if (!textureExpanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTextureExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [textureExpanded]);

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
      const next = selectIsland(selection, islandIndex, hit, e.shiftKey);
      setSelection(next);
      setActiveSubmesh(hit.submeshName);
      setHoveredIslandId(hit.id);
      if (next?.type === "island") {
        setStatus(islandSelectionStatus(islandIndex, next));
      } else if (next?.type === "submesh") {
        setStatus(`Editing whole ${next.name} submesh.`);
      }
      void switchToTexture(textureForSubmesh(champion, hit.submeshName));
    } else if (activeSubmesh && !e.shiftKey) {
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

  function onModelSelectIsland(islandId: number, opts: { shiftKey: boolean }) {
    if (!islandIndex) return;
    const island = islandIndex.islands.find((i) => i.id === islandId);
    if (!island) return;
    const next = selectIsland(selection, islandIndex, island, opts.shiftKey);
    setSelection(next);
    setActiveSubmesh(island.submeshName);
    setHoveredIslandId(island.id);
    if (next?.type === "island") {
      setStatus(islandSelectionStatus(islandIndex, next));
    } else if (next?.type === "submesh") {
      setStatus(`Editing whole ${next.name} submesh.`);
    }
    void switchToTexture(textureForSubmesh(champion, island.submeshName));
  }

  const selectedIslandIds = useMemo(
    () => (selection?.type === "island" ? selection.ids : []),
    [selection],
  );

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
      : selection.ids.length > 1
        ? `${selection.ids.length} islands (${selection.submeshName})`
        : `Island #${selection.ids[0]} (${selection.submeshName})`;

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-chrome text-ink">
      <header className="relative z-20 flex shrink-0 items-center gap-3 border-b border-border bg-chrome/90 px-3 py-2.5 backdrop-blur-md md:px-4">
        <div className="min-w-0 shrink">
          <p className="text-[11px] font-medium tracking-[0.22em] text-copper uppercase">
            Custom Skin Lab
          </p>
          <p className="truncate text-[11px] text-muted">
            {loadingTexture || loadingMesh
              ? "Loading…"
              : `${selectionLabel} · ${texturePath.split("/").pop()}`}
          </p>
        </div>

        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
          <label className="flex items-center gap-2 text-xs text-muted">
            <span className="hidden lg:inline">Champion</span>
            <select
              value={champion.id}
              onChange={(e) => {
                const next = CHAMPIONS.find((c) => c.id === e.target.value);
                if (next) selectChampion(next);
              }}
              className="field !w-auto min-w-[8.5rem] !rounded-lg !py-1.5 !text-sm"
            >
              {CHAMPIONS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.sknUrl ? "" : " (no mesh)"}
                </option>
              ))}
            </select>
          </label>

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
            className="rounded-full border border-border bg-chip px-3 py-1.5 text-xs font-medium text-ink/85 transition hover:bg-surface disabled:opacity-40"
          >
            Reset
          </button>

          <label className="cursor-pointer rounded-full border border-border bg-chip px-3 py-1.5 text-xs font-medium text-ink/85 transition hover:bg-surface">
            Upload
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => void onUpload(e.target.files?.[0])}
            />
          </label>

          <button
            type="button"
            disabled={exporting || !hasImage || loadingTexture}
            onClick={() => void onExport()}
            className="rounded-full bg-copper px-3.5 py-1.5 text-xs font-semibold text-paper transition hover:bg-copper/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {exporting ? "Building…" : "Download .modpkg"}
          </button>
        </div>
      </header>

      <div className="relative min-h-0 flex-1 bg-stage">
        <ModelViewer
          mesh={islandIndex?.mesh ?? null}
          champion={champion}
          revision={modelRevision}
          activeExportPath={texturePath}
          previewCanvasRef={previewCanvasRef}
          bakedByPathRef={bakedByPathRef}
          islandIndex={islandIndex}
          hoverIslandId={hoveredIslandId}
          selectedIslandIds={selectedIslandIds}
          onHoverIsland={onModelHoverIsland}
          onSelectIsland={onModelSelectIsland}
          className="absolute inset-0"
        />

        {/* Texture map — top left of the 3D stage */}
        <div
          className={`pointer-events-none absolute top-3 left-3 flex flex-col gap-2 transition-[width] duration-200 md:top-4 md:left-4 ${
            textureExpanded
              ? "z-20 w-[min(720px,78vw)]"
              : "z-10 w-[min(260px,38vw)] md:w-[min(300px,28vw)]"
          }`}
        >
          <div className="pointer-events-auto overflow-hidden rounded-xl border border-border bg-overlay shadow-soft backdrop-blur-md">
            <div className="flex items-center justify-between gap-2 border-b border-border px-2.5 py-1.5">
              <span className="text-[10px] font-semibold tracking-wide text-muted uppercase">
                Texture
              </span>
              <button
                type="button"
                disabled={!hasImage}
                onClick={() => setTextureExpanded((v) => !v)}
                className="inline-flex size-6 items-center justify-center rounded-md border border-border bg-chip text-ink/85 transition hover:bg-surface disabled:opacity-40"
                aria-pressed={textureExpanded}
                aria-label={
                  textureExpanded
                    ? "Shrink texture"
                    : "Expand texture for easier island picking"
                }
                title={
                  textureExpanded
                    ? "Shrink texture (Esc)"
                    : "Expand texture for easier island picking"
                }
              >
                {textureExpanded ? (
                  <svg
                    viewBox="0 0 16 16"
                    className="size-3.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    {/* Shrink: arrows toward center */}
                    <path d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" />
                  </svg>
                ) : (
                  <svg
                    viewBox="0 0 16 16"
                    className="size-3.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    {/* Expand: arrows toward corners */}
                    <path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" />
                  </svg>
                )}
              </button>
            </div>
            <canvas ref={sourceCanvasRef} className="hidden" />
            <div
              className={`relative bg-checker ${hasImage ? "" : "min-h-[140px]"}`}
            >
              <canvas ref={previewCanvasRef} className="block h-auto w-full" />
              <canvas
                ref={overlayCanvasRef}
                onClick={onPreviewClick}
                onMouseMove={onPreviewMove}
                onMouseLeave={onPreviewLeave}
                className="absolute inset-0 h-full w-full cursor-crosshair"
              />
              {!hasImage && !loadingTexture && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4 text-center text-xs text-muted">
                  Load a starter or upload a texture.
                </div>
              )}
            </div>
          </div>

          <div className="pointer-events-auto flex flex-wrap gap-1.5">
            <label className="flex items-center gap-1.5 rounded-full border border-border bg-chip/90 px-2.5 py-1 text-[11px] text-ink/80 backdrop-blur-sm">
              <input
                type="checkbox"
                checked={showOverlay}
                onChange={(e) => setShowOverlay(e.target.checked)}
                className="size-3 accent-copper"
              />
              UV
            </label>
            <button
              type="button"
              className="rounded-full border border-border bg-chip/90 px-2.5 py-1 text-[11px] text-ink/80 backdrop-blur-sm hover:bg-surface"
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
                className="rounded-full border border-border bg-chip/90 px-2.5 py-1 text-[11px] text-ink/80 backdrop-blur-sm hover:bg-surface"
                onClick={() => void selectSubmesh(activeSubmesh)}
              >
                Whole {activeSubmesh}
              </button>
            )}
          </div>

          {submeshNames.length > 0 && (
            <div className="pointer-events-auto flex max-h-24 flex-wrap gap-1 overflow-y-auto">
              {submeshNames.map((name) => {
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
                    className={`rounded-full px-2 py-1 text-[10px] font-medium transition ${
                      active
                        ? "bg-copper text-paper"
                        : "border border-border bg-chip/90 text-ink/75 backdrop-blur-sm hover:bg-surface"
                    }`}
                  >
                    {name}
                    {alt && <span className="ml-1 opacity-80">↗</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Recolor sliders — right side of the 3D stage */}
        <div className="pointer-events-none absolute top-3 right-3 z-10 w-[min(220px,42vw)] md:top-4 md:right-4 md:w-56">
          <div className="pointer-events-auto flex flex-col gap-3 rounded-xl border border-border bg-overlay p-3 shadow-soft backdrop-blur-md md:p-4">
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
              onChange={(saturation) =>
                commitSettings({ ...settings, saturation })
              }
            />
            <Slider
              label="Brightness"
              min={0}
              max={200}
              value={settings.brightness}
              suffix="%"
              onChange={(brightness) =>
                commitSettings({ ...settings, brightness })
              }
            />
            <label className="flex items-center gap-2 text-[11px] text-ink/75">
              <input
                type="checkbox"
                checked={settings.protectShadows}
                onChange={(e) =>
                  commitSettings({
                    ...settings,
                    protectShadows: e.target.checked,
                  })
                }
                className="size-3.5 accent-copper"
              />
              Protect shadows
            </label>
          </div>
        </div>

        {(status || error) && (
          <div className="pointer-events-none absolute right-3 bottom-3 left-3 z-10 md:right-4 md:bottom-4 md:left-4">
            {error && (
              <p
                className="mb-1 max-w-xl rounded-lg border border-copper/40 bg-copper/15 px-3 py-2 text-xs text-ink backdrop-blur-sm"
                role="alert"
              >
                {error}
              </p>
            )}
            {status && (
              <p
                className="max-w-xl rounded-lg border border-border bg-overlay px-3 py-2 text-xs text-muted backdrop-blur-sm"
                role="status"
              >
                {status}
              </p>
            )}
          </div>
        )}
      </div>

      <details className="shrink-0 border-t border-border bg-chrome/90 text-ink/80 open:pb-3">
        <summary className="cursor-pointer px-4 py-2 text-xs font-semibold tracking-wide text-muted uppercase select-none">
          Mod package details
        </summary>
        <div className="grid gap-3 px-4 pt-1 sm:grid-cols-3">
          <Field label="Skin name">
            <input
              className="field !rounded-lg !py-2 !text-sm"
              value={skinName}
              onChange={(e) => setSkinName(e.target.value)}
              placeholder="Ember Recolor"
            />
          </Field>
          <Field label="Author (optional)">
            <input
              className="field !rounded-lg !py-2 !text-sm"
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder="Your name"
            />
          </Field>
          <Field label="Texture path inside WAD" hint={`Archive: ${champion.wad}`}>
            <input
              className="field !rounded-lg !py-2 font-mono !text-xs"
              value={texturePath}
              onChange={(e) => setTexturePath(e.target.value)}
            />
          </Field>
        </div>
      </details>
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
      <span className="text-[10px] font-semibold tracking-wide text-muted uppercase">
        {label}
      </span>
      {children}
      {hint && <span className="text-[10px] text-muted">{hint}</span>}
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
    <label className="grid gap-1.5">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-muted">{label}</span>
        <span className="font-mono text-ink/90">
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
        className="w-full accent-copper"
      />
    </label>
  );
}
