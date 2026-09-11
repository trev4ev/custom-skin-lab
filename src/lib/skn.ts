/** League of Legends SKN (skinned mesh) parser — versions 0/2/4. */

export type SknSubmesh = {
  name: string;
  startVertex: number;
  numVertices: number;
  startIndex: number;
  numIndices: number;
};

export type SknVertex = {
  u: number;
  v: number;
};

export type SknMesh = {
  version: number;
  submeshes: SknSubmesh[];
  indices: Uint16Array;
  vertices: SknVertex[];
};

function readCString(buf: Uint8Array, offset: number, max: number): string {
  let end = offset;
  const limit = Math.min(buf.length, offset + max);
  while (end < limit && buf[end] !== 0) end++;
  return new TextDecoder().decode(buf.subarray(offset, end));
}

/**
 * Parse an SKN ArrayBuffer into submeshes + UVs.
 * UV is always read from the Basic/Color/Tangent layouts at texcoord offset.
 */
export function parseSkn(buffer: ArrayBuffer): SknMesh {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  const magic = view.getUint32(0, true);
  if (magic !== 0x00112233) {
    throw new Error(`Invalid SKN magic: 0x${magic.toString(16)}`);
  }
  const version = view.getUint16(4, true);
  // minor at 6 unused

  let o = 8;
  const submeshes: SknSubmesh[] = [];

  if (version === 0) {
    const indexCount = view.getInt32(o, true);
    const vertexCount = view.getInt32(o + 4, true);
    o += 8;
    submeshes.push({
      name: "Base",
      startVertex: 0,
      numVertices: vertexCount,
      startIndex: 0,
      numIndices: indexCount,
    });
  } else {
    const rangeCount = view.getUint32(o, true);
    o += 4;
    for (let i = 0; i < rangeCount; i++) {
      const name = readCString(bytes, o, 64);
      submeshes.push({
        name,
        startVertex: view.getInt32(o + 64, true),
        numVertices: view.getInt32(o + 68, true),
        startIndex: view.getInt32(o + 72, true),
        numIndices: view.getInt32(o + 76, true),
      });
      o += 80;
    }
  }

  let indexCount: number;
  let vertexCount: number;
  let vertexSize = 52;
  let vertexType = 0;

  if (version === 4) {
    // flags, indexCount, vertexCount, vertexSize, vertexType, AABB(24), sphere(16)
    o += 4; // flags
    indexCount = view.getInt32(o, true);
    vertexCount = view.getInt32(o + 4, true);
    vertexSize = view.getUint32(o + 8, true);
    vertexType = view.getUint32(o + 12, true);
    o += 16 + 24 + 16;
  } else if (version === 0) {
    indexCount = submeshes[0]!.numIndices;
    vertexCount = submeshes[0]!.numVertices;
  } else {
    // v2
    indexCount = view.getInt32(o, true);
    vertexCount = view.getInt32(o + 4, true);
    o += 8;
  }

  if (vertexType === 1) vertexSize = Math.max(vertexSize, 56);
  if (vertexType === 2) vertexSize = Math.max(vertexSize, 72);

  const indices = new Uint16Array(indexCount);
  for (let i = 0; i < indexCount; i++) {
    indices[i] = view.getUint16(o, true);
    o += 2;
  }

  // Basic layout texcoord @ 0x2C; Color/Tangent keep texcoord there too.
  const uvOffset = 0x2c;
  if (vertexSize < uvOffset + 8) {
    throw new Error(`Unsupported SKN vertex size ${vertexSize}`);
  }

  const vertices: SknVertex[] = new Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) {
    const base = o + i * vertexSize;
    vertices[i] = {
      u: view.getFloat32(base + uvOffset, true),
      v: view.getFloat32(base + uvOffset + 4, true),
    };
  }

  return { version, submeshes, indices, vertices };
}

export async function fetchSkn(url: string): Promise<SknMesh> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load SKN (${res.status})`);
  return parseSkn(await res.arrayBuffer());
}
