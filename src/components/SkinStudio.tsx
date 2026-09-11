"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CHAMPIONS,
  textureForSubmesh,
  type ChampionOption,
  type ChampionTexture,
} from "@/lib/champions";
import {
  DEFAULT_RECOLOR,
  recolorImageData,
  type RecolorSettings,
} from "@/lib/recolor";
import { fetchSkn } from "@/lib/skn";
import {
  buildIslandIndex,
  drawUvOverlay,
  hitTestIsland,
  islandsForSubmesh,
  rasterizeSelectionMask,
  type IslandIndex,
} from "@/lib/uv-islands";

type Selection =
  | null
  | { type: "submesh"; name: string }
  | { type: "island"; id: number; submeshName: string };

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
  const [texturePath, setTexturePath] = useState(CHAMPIONS[0]!.defaultTexture.exportPath);
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

  const sourceRef = useRef<ImageData | null>(null);
  const maskRef = useRef<Uint8Array | null>(null);
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

  const rebuildMask = useCallback(() => {
    const source = sourceRef.current;
    if (!source || !islandIndex) {
      maskRef.current = null;
      return;
    }
    if (!selection) {
      maskRef.current = null; // whole texture
      return;
    }
    maskRef.current = rasterizeSelectionMask(
      islandIndex,
      source.width,
      source.height,
      selection.type === "island"
        ? { type: "island", id: selection.id }
        : { type: "submesh", name: selection.name },
    );
  }, [islandIndex, selection]);

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
      selectedSubmesh: selection?.type === "submesh" ? selection.name : activeSubmesh,
    });
  }, [islandIndex, showOverlay, activeSubmesh, selection]);

  const applyRecolor = useCallback(() => {
    if (holdPreviewRef.current) {
      holdPreviewRef.current = false;
      return;
    }
    const source = sourceRef.current;
    const preview = previewCanvasRef.current;
    const tex = activeTextureRef.current;
    if (!source || !preview) return;
    const ctx = preview.getContext("2d");
    if (!ctx) return;
    const result = recolorImageData(source, settings, maskRef.current);
    ctx.putImageData(result, 0, 0);
    if (tex) bakedByPathRef.current.set(tex.exportPath, result);
  }, [settings]);

  useEffect(() => {
    rebuildMask();
    applyRecolor();
    redrawOverlay();
  }, [rebuildMask, applyRecolor, redrawOverlay]);

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
        if (baked) {
          const preview = previewCanvasRef.current;
          const ctx = preview?.getContext("2d");
          if (preview && ctx) {
            preview.width = baked.width;
            preview.height = baked.height;
            ctx.putImageData(baked, 0, 0);
            holdPreviewRef.current = true;
          }
        }
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

  const loadMesh = useCallback(async (next: ChampionOption) => {
    if (!next.sknUrl) {
      setIslandIndex(null);
      setActiveSubmesh(null);
      setSelection(null);
      return;
    }
    setLoadingMesh(true);
    try {
      const mesh = await fetchSkn(next.sknUrl);
      const index = buildIslandIndex(mesh);
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
      setIslandIndex(null);
      setActiveSubmesh(null);
      setSelection(null);
      setError(err instanceof Error ? err.message : "Failed to load mesh UVs");
    } finally {
      setLoadingMesh(false);
    }
  }, [switchToTexture]);

  const loadStarterTexture = useCallback(
    async (next: ChampionOption) => {
      setLoadingTexture(true);
      setError(null);
      sourcesByPathRef.current.clear();
      bakedByPathRef.current.clear();
      activeTextureRef.current = null;
      try {
        const tex = next.defaultTexture;
        const img = await urlToImage(tex.url);
        await paintImage(img, tex);
        await loadMesh(next);
      } catch (err) {
        setHasImage(false);
        setError(err instanceof Error ? err.message : "Failed to load starter texture");
      } finally {
        setLoadingTexture(false);
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
    void loadStarterTexture(CHAMPIONS[0]!);
  }, [loadStarterTexture]);

  function selectChampion(next: ChampionOption) {
    setChampionId(next.id);
    setTexturePath(next.defaultTexture.exportPath);
    setSelection(null);
    void loadStarterTexture(next);
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
      await paintImage(img, tex);
      holdPreviewRef.current = false;
      rebuildMask();
      applyRecolor();
      redrawOverlay();
      setStatus(`Using uploaded texture: ${file.name}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    }
  }

  function onPreviewClick(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!islandIndex || !previewCanvasRef.current) return;
    const canvas = previewCanvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    const u = x / Math.max(1, canvas.width - 1);
    const v = y / Math.max(1, canvas.height - 1);

    const hit = hitTestIsland(islandIndex, u, v, activeSubmesh);
    if (hit) {
      setSelection({ type: "island", id: hit.id, submeshName: hit.submeshName });
      setActiveSubmesh(hit.submeshName);
      setStatus(
        `Selected island #${hit.id} in ${hit.submeshName} (${hit.faceCount} faces). Edits apply only here.`,
      );
      void switchToTexture(textureForSubmesh(champion, hit.submeshName));
    } else if (activeSubmesh) {
      setSelection({ type: "submesh", name: activeSubmesh });
      setStatus(`No island under cursor — editing whole ${activeSubmesh} submesh.`);
    }
  }

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

      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          championId: champion.id,
          skinName,
          author: author || undefined,
          textures,
          thumbnailBase64: thumb,
        }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error || `Export failed (${res.status})`);
      }
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") || "";
      const match = /filename="([^"]+)"/.exec(disposition);
      const filename = match?.[1] || `${champion.id}-recolor.modpkg`;
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
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10 md:py-14">
      <header className="flex flex-col gap-3">
        <p className="text-sm font-medium tracking-[0.2em] text-copper uppercase">
          Custom Skin Lab
        </p>
        <h1 className="max-w-2xl font-display text-4xl leading-tight text-ink md:text-5xl">
          Recolor islands. Export a playable `.modpkg`.
        </h1>
        <p className="max-w-2xl text-base leading-relaxed text-ink/70">
          Pick a submesh (Body, Tails, …), click a UV island, then recolor only that
          part. Submeshes that use a different diffuse — like Ahri&apos;s tails —
          swap the preview automatically from skin data.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
        <section className="rounded-2xl border border-ink/10 bg-panel/80 p-5 shadow-soft backdrop-blur">
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
                onClick={() => void loadStarterTexture(champion)}
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

          <div className="overflow-hidden rounded-xl border border-ink/10 bg-checker">
            <canvas ref={sourceCanvasRef} className="hidden" />
            <div
              className={`relative mx-auto w-fit max-w-full ${hasImage ? "" : "min-h-[280px] w-full"}`}
            >
              <canvas
                ref={previewCanvasRef}
                onClick={onPreviewClick}
                className="block h-auto max-h-[460px] max-w-full cursor-crosshair"
              />
              <canvas
                ref={overlayCanvasRef}
                className="pointer-events-none absolute inset-0 h-full w-full"
              />
              {!hasImage && !loadingTexture && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-8 text-center text-sm text-ink/50">
                  Choose a starter champion or upload an extracted texture.
                </div>
              )}
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
                  const active =
                    selection?.type === "island" && selection.id === island.id;
                  return (
                    <button
                      key={island.id}
                      type="button"
                      title={`${island.faceCount} faces`}
                      onClick={() => {
                        setSelection({
                          type: "island",
                          id: island.id,
                          submeshName: island.submeshName,
                        });
                        setStatus(
                          `Selected island #${island.id} (${island.faceCount} faces).`,
                        );
                      }}
                      className={`rounded-md px-2 py-1 font-mono text-[10px] transition ${
                        active
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
              onChange={(hueShift) => setSettings((s) => ({ ...s, hueShift }))}
            />
            <Slider
              label="Saturation"
              min={0}
              max={200}
              value={settings.saturation}
              suffix="%"
              onChange={(saturation) => setSettings((s) => ({ ...s, saturation }))}
            />
            <Slider
              label="Brightness"
              min={0}
              max={200}
              value={settings.brightness}
              suffix="%"
              onChange={(brightness) => setSettings((s) => ({ ...s, brightness }))}
            />
            <label className="flex items-center gap-2 text-sm text-ink/80">
              <input
                type="checkbox"
                checked={settings.protectShadows}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, protectShadows: e.target.checked }))
                }
                className="size-4 accent-copper"
              />
              Protect deep shadows / linework
            </label>
          </div>
        </section>

        <section className="flex flex-col gap-5 rounded-2xl border border-ink/10 bg-panel/80 p-5 shadow-soft backdrop-blur">
          <h2 className="font-display text-xl text-ink">Mod package</h2>

          <Field label="Champion">
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
          </Field>

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
            Export writes the current preview (with island edits applied).
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
