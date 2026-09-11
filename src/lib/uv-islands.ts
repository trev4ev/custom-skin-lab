import type { SknMesh, SknSubmesh } from "@/lib/skn";

export type UvIsland = {
  id: number;
  submeshName: string;
  /** Triangle corner indices into mesh.indices (start of each triangle *is* face index into this list conceptually) */
  faceStarts: number[];
  /** Axis-aligned UV bounds */
  minU: number;
  maxU: number;
  minV: number;
  maxV: number;
  faceCount: number;
};

export type IslandIndex = {
  mesh: SknMesh;
  islands: UvIsland[];
  /** faceIndex -> islandId for faces that belong to an island */
  faceToIsland: Int32Array;
};

function keyEdge(a: number, b: number): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Build UV islands within each submesh by unioning triangles that share mesh edges.
 * (Shared UV-space adjacency via shared vertex indices — standard for SKN.)
 */
export function buildIslandIndex(mesh: SknMesh): IslandIndex {
  const islands: UvIsland[] = [];
  // Global face id = triangle index in the full index buffer / 3
  const totalFaces = Math.floor(mesh.indices.length / 3);
  const faceToIsland = new Int32Array(totalFaces).fill(-1);

  for (const sub of mesh.submeshes) {
    const localFaces: number[] = [];
    for (let i = sub.startIndex; i < sub.startIndex + sub.numIndices; i += 3) {
      localFaces.push(i / 3);
    }
    if (localFaces.length === 0) continue;

    const parent = localFaces.map((_, i) => i);
    const find = (x: number): number =>
      parent[x] === x ? x : (parent[x] = find(parent[x]!));
    const unite = (a: number, b: number) => {
      a = find(a);
      b = find(b);
      if (a !== b) parent[b] = a;
    };

    const edgeMap = new Map<string, number>();
    localFaces.forEach((faceId, localIdx) => {
      const base = faceId * 3;
      const a = mesh.indices[base]!;
      const b = mesh.indices[base + 1]!;
      const c = mesh.indices[base + 2]!;
      for (const [u, v] of [
        [a, b],
        [b, c],
        [c, a],
      ] as const) {
        const k = keyEdge(u, v);
        const prev = edgeMap.get(k);
        if (prev !== undefined) unite(prev, localIdx);
        else edgeMap.set(k, localIdx);
      }
    });

    const groups = new Map<number, number[]>();
    localFaces.forEach((faceId, localIdx) => {
      const root = find(localIdx);
      const list = groups.get(root) ?? [];
      list.push(faceId);
      groups.set(root, list);
    });

    for (const faceIds of groups.values()) {
      // Skip tiny degenerate islands (noise)
      if (faceIds.length < 2) continue;
      let minU = Infinity,
        maxU = -Infinity,
        minV = Infinity,
        maxV = -Infinity;
      const faceStarts: number[] = [];
      for (const faceId of faceIds) {
        faceStarts.push(faceId * 3);
        for (let k = 0; k < 3; k++) {
          const vi = mesh.indices[faceId * 3 + k]!;
          const { u, v } = mesh.vertices[vi]!;
          if (u < minU) minU = u;
          if (u > maxU) maxU = u;
          if (v < minV) minV = v;
          if (v > maxV) maxV = v;
        }
      }
      const id = islands.length;
      for (const faceId of faceIds) faceToIsland[faceId] = id;
      islands.push({
        id,
        submeshName: sub.name,
        faceStarts,
        minU,
        maxU,
        minV,
        maxV,
        faceCount: faceIds.length,
      });
    }
  }

  // Largest islands first within each submesh for nicer picking defaults
  islands.sort((a, b) => {
    if (a.submeshName !== b.submeshName) {
      return a.submeshName.localeCompare(b.submeshName);
    }
    return b.faceCount - a.faceCount;
  });
  // Reassign ids after sort + rebuild faceToIsland
  faceToIsland.fill(-1);
  islands.forEach((island, i) => {
    island.id = i;
    for (const start of island.faceStarts) {
      faceToIsland[start / 3] = i;
    }
  });

  return { mesh, islands, faceToIsland };
}

function pointInTriangle(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): boolean {
  const v0x = cx - ax,
    v0y = cy - ay;
  const v1x = bx - ax,
    v1y = by - ay;
  const v2x = px - ax,
    v2y = py - ay;
  const dot00 = v0x * v0x + v0y * v0y;
  const dot01 = v0x * v1x + v0y * v1y;
  const dot02 = v0x * v2x + v0y * v2y;
  const dot11 = v1x * v1x + v1y * v1y;
  const dot12 = v1x * v2x + v1y * v2y;
  const inv = 1 / (dot00 * dot11 - dot01 * dot01 || 1e-12);
  const u = (dot11 * dot02 - dot01 * dot12) * inv;
  const v = (dot00 * dot12 - dot01 * dot02) * inv;
  return u >= 0 && v >= 0 && u + v <= 1;
}

/** UV hit-test. u/v in texture space (V=0 at top, same as canvas). */
export function hitTestIsland(
  index: IslandIndex,
  u: number,
  v: number,
  submeshFilter?: string | null,
): UvIsland | null {
  const { mesh, islands } = index;
  // Prefer smaller islands when overlapping (more specific)
  let best: UvIsland | null = null;
  for (const island of islands) {
    if (submeshFilter && island.submeshName !== submeshFilter) continue;
    if (u < island.minU - 0.001 || u > island.maxU + 0.001) continue;
    if (v < island.minV - 0.001 || v > island.maxV + 0.001) continue;
    for (const start of island.faceStarts) {
      const a = mesh.vertices[mesh.indices[start]!]!;
      const b = mesh.vertices[mesh.indices[start + 1]!]!;
      const c = mesh.vertices[mesh.indices[start + 2]!]!;
      if (pointInTriangle(u, v, a.u, a.v, b.u, b.v, c.u, c.v)) {
        if (!best || island.faceCount < best.faceCount) best = island;
        break;
      }
    }
  }
  return best;
}

export function islandsForSubmesh(index: IslandIndex, submeshName: string): UvIsland[] {
  return index.islands.filter((i) => i.submeshName === submeshName);
}

/**
 * Rasterize selection into an alpha mask matching texture size.
 * selection: null = whole texture; {type:'submesh', name}; {type:'island', id}
 */
export function rasterizeSelectionMask(
  index: IslandIndex,
  width: number,
  height: number,
  selection:
    | null
    | { type: "submesh"; name: string }
    | { type: "island"; id: number },
): Uint8Array {
  const mask = new Uint8Array(width * height);
  if (!selection) {
    mask.fill(255);
    return mask;
  }

  const { mesh } = index;
  let faceStarts: number[] = [];
  if (selection.type === "island") {
    const island = index.islands.find((i) => i.id === selection.id);
    if (!island) return mask;
    faceStarts = island.faceStarts;
  } else {
    const sub = mesh.submeshes.find((s) => s.name === selection.name);
    if (!sub) return mask;
    for (let i = sub.startIndex; i < sub.startIndex + sub.numIndices; i += 3) {
      faceStarts.push(i);
    }
  }

  // Draw filled triangles into mask (scanline-ish via bounding box + point test)
  for (const start of faceStarts) {
    const a = mesh.vertices[mesh.indices[start]!]!;
    const b = mesh.vertices[mesh.indices[start + 1]!]!;
    const c = mesh.vertices[mesh.indices[start + 2]!]!;
    // Image space (DirectX / League): V=0 at top, matches canvas Y.
    const pts = [a, b, c].map((p) => ({
      x: p.u * (width - 1),
      y: p.v * (height - 1),
    }));
    const minX = Math.max(0, Math.floor(Math.min(pts[0]!.x, pts[1]!.x, pts[2]!.x)));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(pts[0]!.x, pts[1]!.x, pts[2]!.x)));
    const minY = Math.max(0, Math.floor(Math.min(pts[0]!.y, pts[1]!.y, pts[2]!.y)));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(pts[0]!.y, pts[1]!.y, pts[2]!.y)));
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (
          pointInTriangle(
            x,
            y,
            pts[0]!.x,
            pts[0]!.y,
            pts[1]!.x,
            pts[1]!.y,
            pts[2]!.x,
            pts[2]!.y,
          )
        ) {
          mask[y * width + x] = 255;
        }
      }
    }
  }
  return mask;
}

/** Draw UV wireframe / selection highlight onto a canvas in image space. */
export function drawUvOverlay(
  ctx: CanvasRenderingContext2D,
  index: IslandIndex,
  width: number,
  height: number,
  opts: {
    submeshFilter?: string | null;
    selectedIslandId?: number | null;
    selectedSubmesh?: string | null;
  } = {},
) {
  const { mesh, islands } = index;
  ctx.clearRect(0, 0, width, height);

  const toXY = (u: number, v: number) => ({
    x: u * (width - 1),
    y: v * (height - 1),
  });

  for (const island of islands) {
    if (opts.submeshFilter && island.submeshName !== opts.submeshFilter) continue;
    const isSelectedIsland = opts.selectedIslandId === island.id;
    const isSelectedSubmesh =
      opts.selectedSubmesh === island.submeshName && opts.selectedIslandId == null;

    ctx.strokeStyle = isSelectedIsland
      ? "rgba(255, 196, 72, 0.95)"
      : isSelectedSubmesh
        ? "rgba(80, 180, 255, 0.7)"
        : "rgba(255, 255, 255, 0.28)";
    ctx.lineWidth = isSelectedIsland ? 1.5 : 0.75;

    for (const start of island.faceStarts) {
      const a = toXY(mesh.vertices[mesh.indices[start]!]!.u, mesh.vertices[mesh.indices[start]!]!.v);
      const b = toXY(
        mesh.vertices[mesh.indices[start + 1]!]!.u,
        mesh.vertices[mesh.indices[start + 1]!]!.v,
      );
      const c = toXY(
        mesh.vertices[mesh.indices[start + 2]!]!.u,
        mesh.vertices[mesh.indices[start + 2]!]!.v,
      );
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(c.x, c.y);
      ctx.closePath();
      if (isSelectedIsland) {
        ctx.fillStyle = "rgba(255, 196, 72, 0.18)";
        ctx.fill();
      }
      ctx.stroke();
    }
  }
}

export function listSubmeshes(mesh: SknMesh): SknSubmesh[] {
  return mesh.submeshes;
}
