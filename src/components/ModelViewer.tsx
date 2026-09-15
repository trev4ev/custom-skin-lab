"use client";

import { useEffect, useRef, type RefObject } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  textureForSubmesh,
  type ChampionOption,
} from "@/lib/champions";
import type { SknMesh } from "@/lib/skn";
import { islandsSharingUv, type IslandIndex } from "@/lib/uv-islands";

export type ModelViewerProps = {
  mesh: SknMesh | null;
  champion: ChampionOption;
  /** Bumped whenever a diffuse should refresh on the model. */
  revision: number;
  activeExportPath: string | null;
  previewCanvasRef: RefObject<HTMLCanvasElement | null>;
  bakedByPathRef: RefObject<Map<string, ImageData>>;
  /** Full island index for hover/selection face highlighting. */
  islandIndex?: IslandIndex | null;
  /** Island under the pointer — filled tint on the mesh. */
  hoverIslandId?: number | null;
  /** Selected islands — outline only so recolors stay visible. */
  selectedIslandIds?: number[] | null;
  /** Fired when the pointer hovers a mesh island (or null when leaving). */
  onHoverIsland?: (islandId: number | null) => void;
  /** Fired when the user clicks a mesh island. */
  onSelectIsland?: (islandId: number, opts: { shiftKey: boolean }) => void;
  className?: string;
};

type SubmeshEntry = {
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  exportPath: string;
};

function imageDataToCanvas(image: ImageData): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = image.width;
  c.height = image.height;
  c.getContext("2d")!.putImageData(image, 0, 0);
  return c;
}

/** Frame camera on an object so it fills most of the viewport. */
function frameObject(
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  object: THREE.Object3D,
) {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;

  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  const maxDim = Math.max(size.x, size.y, size.z, 1);
  const fov = THREE.MathUtils.degToRad(camera.fov);
  // 1.15 = slight padding so the model isn't edge-clipped
  let distance = ((maxDim * 0.5) / Math.tan(fov * 0.5)) * 1.15;
  // Account for aspect: wider canvases need a bit more distance for tall models
  if (camera.aspect > 0) {
    const fitW = ((maxDim * 0.5) / camera.aspect / Math.tan(fov * 0.5)) * 1.15;
    distance = Math.max(distance, fitW);
  }

  controls.target.copy(center);
  const dir = new THREE.Vector3(0.65, 0.28, 0.9).normalize();
  camera.position.copy(center).addScaledVector(dir, distance);
  camera.near = Math.max(0.05, distance / 100);
  camera.far = Math.max(2000, distance * 20);
  controls.minDistance = distance * 0.4;
  controls.maxDistance = distance * 4;
  camera.updateProjectionMatrix();
  controls.update();
}

/**
 * Bind-pose SKN viewer with orbit controls.
 * Per-submesh diffuses update live as you recolor.
 */
export function ModelViewer({
  mesh,
  champion,
  revision,
  activeExportPath,
  previewCanvasRef,
  bakedByPathRef,
  islandIndex = null,
  hoverIslandId = null,
  selectedIslandIds = null,
  onHoverIsland,
  onSelectIsland,
  className,
}: ModelViewerProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const rootRef = useRef<THREE.Group | null>(null);
  const entriesRef = useRef<SubmeshEntry[]>([]);
  const texturesRef = useRef<Map<string, THREE.Texture>>(new Map());
  const highlightRef = useRef<THREE.Group | null>(null);
  const frameRef = useRef(0);
  const championRef = useRef(champion);
  championRef.current = champion;
  const islandIndexRef = useRef(islandIndex);
  islandIndexRef.current = islandIndex;
  const onHoverIslandRef = useRef(onHoverIsland);
  onHoverIslandRef.current = onHoverIsland;
  const onSelectIslandRef = useRef(onSelectIsland);
  onSelectIslandRef.current = onSelectIsland;
  const raycasterRef = useRef(new THREE.Raycaster());
  const pointerRef = useRef(new THREE.Vector2());
  const pointerDownRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = null;

    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
    camera.position.set(120, 70, 150);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Fill the mount box exactly
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    mount.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    controls.target.set(0, 0, 0);
    controlsRef.current = controls;

    scene.add(new THREE.HemisphereLight(0xf1faee, 0x1d3557, 1.15));
    const key = new THREE.DirectionalLight(0xffffff, 1.35);
    key.position.set(80, 140, 100);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xa8dadc, 0.45);
    fill.position.set(-100, 60, -80);
    scene.add(fill);

    const root = new THREE.Group();
    scene.add(root);
    rootRef.current = root;

    const resize = () => {
      const w = mount.clientWidth || 1;
      const h = mount.clientHeight || 1;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    const tick = () => {
      controls.update();
      renderer.render(scene, camera);
      frameRef.current = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      cancelAnimationFrame(frameRef.current);
      ro.disconnect();
      controls.dispose();
      for (const tex of texturesRef.current.values()) tex.dispose();
      texturesRef.current.clear();
      for (const entry of entriesRef.current) {
        entry.mesh.geometry.dispose();
        entry.material.dispose();
      }
      entriesRef.current = [];
      if (highlightRef.current) {
        highlightRef.current.traverse((obj) => {
          if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
            obj.geometry.dispose();
            const mat = obj.material;
            if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
            else mat.dispose();
          }
        });
        highlightRef.current = null;
      }
      renderer.dispose();
      if (renderer.domElement.parentElement === mount) {
        mount.removeChild(renderer.domElement);
      }
      rendererRef.current = null;
      cameraRef.current = null;
      controlsRef.current = null;
      rootRef.current = null;
    };
  }, []);

  const clearHighlight = () => {
    const root = rootRef.current;
    const highlight = highlightRef.current;
    if (!root || !highlight) return;
    root.remove(highlight);
    highlight.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
        obj.geometry.dispose();
        const mat = obj.material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat.dispose();
      }
    });
    highlightRef.current = null;
  };

  const islandPositions = (islandId: number): number[] | null => {
    const sourceMesh = mesh;
    const index = islandIndex;
    if (!sourceMesh || !index) return null;
    const shared = islandsSharingUv(index, islandId);
    if (shared.length === 0) return null;
    const positions: number[] = [];
    for (const island of shared) {
      for (const start of island.faceStarts) {
        for (let k = 0; k < 3; k++) {
          const v = sourceMesh.vertices[sourceMesh.indices[start + k]!]!;
          positions.push(v.x, v.y, v.z);
        }
      }
    }
    return positions.length > 0 ? positions : null;
  };

  /** Hover = filled tint; selection = outline only (recolors stay readable). */
  const setIslandHighlights = (
    hoverId: number | null,
    selectedIds: number[],
  ) => {
    const root = rootRef.current;
    clearHighlight();
    if (!root) return;
    if (hoverId == null && selectedIds.length === 0) return;

    const group = new THREE.Group();
    group.name = "__island_highlights";

    if (hoverId != null) {
      const positions = islandPositions(hoverId);
      if (positions) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute(
          "position",
          new THREE.Float32BufferAttribute(positions, 3),
        );
        geo.computeVertexNormals();
        const fill = new THREE.Mesh(
          geo,
          new THREE.MeshBasicMaterial({
            color: 0xe63946,
            transparent: true,
            opacity: 0.5,
            side: THREE.DoubleSide,
            depthTest: false,
            depthWrite: false,
            toneMapped: false,
          }),
        );
        fill.renderOrder = 10;
        group.add(fill);
        const hoverEdges = new THREE.LineSegments(
          new THREE.EdgesGeometry(geo, 40),
          new THREE.LineBasicMaterial({
            color: 0xa8dadc,
            transparent: true,
            opacity: 0.9,
            depthTest: false,
            toneMapped: false,
          }),
        );
        hoverEdges.renderOrder = 11;
        group.add(hoverEdges);
      }
    }

    // Deduplicate UV-shared groups so mirrored pieces aren't outlined twice.
    const outlined = new Set<number>();
    for (const selectedId of selectedIds) {
      if (outlined.has(selectedId)) continue;
      const shared = islandIndex
        ? islandsSharingUv(islandIndex, selectedId)
        : [];
      for (const s of shared) outlined.add(s.id);
      outlined.add(selectedId);

      const positions = islandPositions(selectedId);
      if (positions) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute(
          "position",
          new THREE.Float32BufferAttribute(positions, 3),
        );
        // Outline only — no fill — so the live recolor stays visible.
        const outline = new THREE.LineSegments(
          new THREE.EdgesGeometry(geo, 25),
          new THREE.LineBasicMaterial({
            color: 0xe63946,
            transparent: true,
            opacity: 1,
            depthTest: false,
            toneMapped: false,
          }),
        );
        outline.renderOrder = 12;
        group.add(outline);
        geo.dispose(); // EdgesGeometry cloned the data
      }
    }

    if (group.children.length === 0) return;
    root.add(group);
    highlightRef.current = group;
  };

  const resolveSource = (
    exportPath: string,
  ): HTMLCanvasElement | string | null => {
    if (activeExportPath === exportPath && previewCanvasRef.current) {
      return previewCanvasRef.current;
    }
    const baked = bakedByPathRef.current?.get(exportPath);
    if (baked) return imageDataToCanvas(baked);
    return null;
  };

  const applyTextureToMaterial = (
    material: THREE.MeshStandardMaterial,
    exportPath: string,
    fallbackUrl: string,
  ) => {
    const source = resolveSource(exportPath);
    let texture = texturesRef.current.get(exportPath);

    if (source instanceof HTMLCanvasElement) {
      if (texture && !(texture instanceof THREE.CanvasTexture)) {
        texture.dispose();
        texture = undefined;
        texturesRef.current.delete(exportPath);
      }
      if (!texture) {
        const canvasTex = new THREE.CanvasTexture(source);
        canvasTex.colorSpace = THREE.SRGBColorSpace;
        // League UVs are DirectX-style (V=0 at top)
        canvasTex.flipY = false;
        canvasTex.wrapS = THREE.ClampToEdgeWrapping;
        canvasTex.wrapT = THREE.ClampToEdgeWrapping;
        texturesRef.current.set(exportPath, canvasTex);
        texture = canvasTex;
      } else {
        const canvasTex = texture as THREE.CanvasTexture;
        if (canvasTex.image !== source) canvasTex.image = source;
        canvasTex.needsUpdate = true;
      }
      material.map = texture;
      material.needsUpdate = true;
      return;
    }

    if (texture instanceof THREE.CanvasTexture) {
      texture.dispose();
      texturesRef.current.delete(exportPath);
      texture = undefined;
    }

    if (texture) {
      material.map = texture;
      material.needsUpdate = true;
      return;
    }

    const loader = new THREE.TextureLoader();
    loader.load(fallbackUrl, (tex) => {
      // Ignore late loads after the material was disposed / replaced on champion switch.
      if (!entriesRef.current.some((e) => e.material === material)) {
        tex.dispose();
        return;
      }
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.flipY = false;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      texturesRef.current.set(exportPath, tex);
      material.map = tex;
      material.needsUpdate = true;
    });
  };

  // Rebuild geometry when mesh changes
  useEffect(() => {
    const root = rootRef.current;
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!root) return;

    for (const entry of entriesRef.current) {
      root.remove(entry.mesh);
      entry.mesh.geometry.dispose();
      entry.material.dispose();
    }
    entriesRef.current = [];
    for (const tex of texturesRef.current.values()) tex.dispose();
    texturesRef.current.clear();
    clearHighlight();
    root.position.set(0, 0, 0);
    root.scale.set(1, 1, 1);

    if (!mesh) return;

    let minX = Infinity,
      minY = Infinity,
      minZ = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity,
      maxZ = -Infinity;

    for (const sub of mesh.submeshes) {
      const positions: number[] = [];
      const normals: number[] = [];
      const uvs: number[] = [];
      const idx: number[] = [];
      const remap = new Map<number, number>();

      for (let i = sub.startIndex; i < sub.startIndex + sub.numIndices; i++) {
        const vi = mesh.indices[i]!;
        let local = remap.get(vi);
        if (local === undefined) {
          local = remap.size;
          remap.set(vi, local);
          const v = mesh.vertices[vi]!;
          positions.push(v.x, v.y, v.z);
          normals.push(v.nx, v.ny, v.nz);
          uvs.push(v.u, v.v);
          minX = Math.min(minX, v.x);
          minY = Math.min(minY, v.y);
          minZ = Math.min(minZ, v.z);
          maxX = Math.max(maxX, v.x);
          maxY = Math.max(maxY, v.y);
          maxZ = Math.max(maxZ, v.z);
        }
        idx.push(local);
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
      geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
      geo.setIndex(idx);

      const texInfo = textureForSubmesh(champion, sub.name);
      // League character textures are alpha-tested cutouts. Using Three's transparent
      // queue re-sorts meshes by camera depth and causes wrong parts to draw on top.
      const material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        metalness: 0.05,
        roughness: 0.72,
        side: THREE.DoubleSide,
        transparent: false,
        alphaTest: 0.4,
        depthWrite: true,
        depthTest: true,
      });
      applyTextureToMaterial(material, texInfo.exportPath, texInfo.url);

      const threeMesh = new THREE.Mesh(geo, material);
      threeMesh.name = sub.name;
      threeMesh.renderOrder = mesh.submeshes.indexOf(sub);
      // Triangle i in this buffer maps to SKN face id (startIndex/3 + i).
      threeMesh.userData.sknFaceOffset = Math.floor(sub.startIndex / 3);
      const hidden =
        /proxy/i.test(sub.name) ||
        champion.hiddenSubmeshes.some(
          (h) => h.toLowerCase() === sub.name.toLowerCase(),
        );
      threeMesh.visible = !hidden;
      root.add(threeMesh);
      entriesRef.current.push({
        mesh: threeMesh,
        material,
        exportPath: texInfo.exportPath,
      });
    }

    if (Number.isFinite(minX) && camera && controls) {
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const cz = (minZ + maxZ) / 2;
      const maxDim = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1;
      const targetSize = 100;
      const s = targetSize / maxDim;

      // Mirror X for League → Three, scale to a consistent size, center at origin
      root.scale.set(-s, s, s);
      root.position.set(s * cx, -s * cy, -s * cz);

      // Wait a frame so the mount has real dimensions for aspect-correct framing
      requestAnimationFrame(() => {
        const mount = mountRef.current;
        const renderer = rendererRef.current;
        if (mount && renderer) {
          const w = mount.clientWidth || 1;
          const h = mount.clientHeight || 1;
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          renderer.setSize(w, h, false);
        }
        frameObject(camera, controls, root);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mesh, champion]);

  // Refresh maps when recolor revision changes
  useEffect(() => {
    for (const entry of entriesRef.current) {
      const texInfo = textureForSubmesh(championRef.current, entry.mesh.name);
      entry.exportPath = texInfo.exportPath;
      applyTextureToMaterial(entry.material, texInfo.exportPath, texInfo.url);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, activeExportPath, mesh]);

  // Raycast hover / click on the 3D model → same island ids as the UV canvas.
  useEffect(() => {
    const renderer = rendererRef.current;
    const camera = cameraRef.current;
    if (!renderer || !camera) return;
    const el = renderer.domElement;
    el.style.cursor = mesh ? "crosshair" : "";

    const pickIsland = (clientX: number, clientY: number): number | null => {
      const index = islandIndexRef.current;
      if (!index || entriesRef.current.length === 0) return null;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return null;
      pointerRef.current.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointerRef.current.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycasterRef.current.setFromCamera(pointerRef.current, camera);
      const targets = entriesRef.current
        .map((e) => e.mesh)
        .filter((m) => m.visible);
      const hits = raycasterRef.current.intersectObjects(targets, false);
      const hit = hits[0];
      if (!hit || hit.faceIndex == null) return null;
      const offset = Number(hit.object.userData.sknFaceOffset ?? 0);
      const faceId = offset + hit.faceIndex;
      const islandId = index.faceToIsland[faceId] ?? -1;
      return islandId >= 0 ? islandId : null;
    };

    const onMove = (e: PointerEvent) => {
      // Skip hover updates while orbit-dragging.
      if (pointerDownRef.current) {
        const dx = e.clientX - pointerDownRef.current.x;
        const dy = e.clientY - pointerDownRef.current.y;
        if (dx * dx + dy * dy > 16) return;
      }
      const id = pickIsland(e.clientX, e.clientY);
      onHoverIslandRef.current?.(id);
    };
    const onLeave = () => {
      onHoverIslandRef.current?.(null);
    };
    const onDown = (e: PointerEvent) => {
      pointerDownRef.current = { x: e.clientX, y: e.clientY };
    };
    const onUp = (e: PointerEvent) => {
      const down = pointerDownRef.current;
      pointerDownRef.current = null;
      if (!down) return;
      const dx = e.clientX - down.x;
      const dy = e.clientY - down.y;
      if (dx * dx + dy * dy > 25) return; // treat as orbit, not click
      const id = pickIsland(e.clientX, e.clientY);
      if (id != null) onSelectIslandRef.current?.(id, { shiftKey: e.shiftKey });
    };

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    return () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      el.style.cursor = "";
    };
  }, [mesh, islandIndex]);

  // Hover fill + selection outline on the 3D mesh.
  useEffect(() => {
    setIslandHighlights(hoverIslandId ?? null, selectedIslandIds ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoverIslandId, selectedIslandIds, islandIndex, mesh]);

  return (
    <div className={`relative h-full w-full min-h-0 ${className ?? ""}`}>
      <div
        ref={mountRef}
        className="bg-stage-checker absolute inset-0 touch-none overflow-hidden"
      />
      {!mesh && (
        <p className="pointer-events-none absolute inset-0 z-[1] flex items-center justify-center text-sm text-muted">
          Load a champion mesh to inspect in 3D.
        </p>
      )}
    </div>
  );
}
