import { pack as msgpackEncode } from "msgpackr";
import { hashBytes, hashPath } from "./hash";

export const METADATA_PATH = "_meta_/info.msgpack";
export const README_PATH = "_meta_/readme.md";
export const LICENSE_PATH = "_meta_/license";
export const THUMBNAIL_PATH = "_meta_/thumbnail.webp";

const MAGIC = new TextEncoder().encode("_modpkg_");
const FORMAT_VERSION = 1;
const CHUNK_RECORD_SIZE = 61;
const INDEX_NONE = 0xffffffff;
const COMPRESSION_NONE = 0;

export type ModpkgAuthor = {
  name: string;
  role?: string | null;
};

export type ModpkgLicense =
  | { type: "none" }
  | { type: "spdx"; spdx_id: string }
  | { type: "custom"; name: string; url: string };

export type ModpkgMetadata = {
  schema_version: number;
  name: string;
  display_name: string;
  description?: string | null;
  version: string;
  authors: ModpkgAuthor[];
  license: ModpkgLicense;
  tags?: string[];
  champions?: string[];
  maps?: string[];
  layers?: Array<{
    name: string;
    priority: number;
    description?: string;
  }>;
};

export type ModpkgChunkInput = {
  path: string;
  wad: string;
  layer?: string;
  data: Uint8Array;
};

export type PackModpkgInput = {
  metadata: ModpkgMetadata;
  chunks: ModpkgChunkInput[];
  readme?: string;
  licenseText?: string;
  thumbnail?: Uint8Array;
};

type Prepared = {
  path: string;
  pathHash: bigint;
  layer: string;
  wad: string;
  data: Uint8Array;
  meta: boolean;
};

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Browser-safe byte writer (no Node Buffer). */
class Writer {
  private parts: Uint8Array[] = [];
  private scratch: number[] = [];
  length = 0;

  private flush() {
    if (!this.scratch.length) return;
    const buf = Uint8Array.from(this.scratch);
    this.parts.push(buf);
    this.length += buf.length;
    this.scratch = [];
  }

  writeU8(v: number) {
    this.scratch.push(v & 0xff);
  }

  writeU32(v: number) {
    this.scratch.push(
      v & 0xff,
      (v >>> 8) & 0xff,
      (v >>> 16) & 0xff,
      (v >>> 24) & 0xff,
    );
  }

  writeI32(v: number) {
    this.writeU32(v >>> 0);
  }

  writeU64(v: bigint) {
    const mask = BigInt(0xffffffff);
    this.writeU32(Number(v & mask));
    this.writeU32(Number((v >> BigInt(32)) & mask));
  }

  writeBytes(bytes: Uint8Array) {
    this.flush();
    this.parts.push(bytes);
    this.length += bytes.length;
  }

  writeCString(s: string) {
    this.writeBytes(utf8(s));
    this.writeU8(0);
  }

  align8() {
    this.flush();
    const pad = (8 - (this.length % 8)) % 8;
    if (pad) this.writeBytes(new Uint8Array(pad));
  }

  reserve(size: number): number {
    this.flush();
    const offset = this.length;
    this.parts.push(new Uint8Array(size));
    this.length += size;
    return offset;
  }

  patch(offset: number, bytes: Uint8Array) {
    this.flush();
    let cursor = 0;
    for (const part of this.parts) {
      const end = cursor + part.length;
      if (offset >= cursor && offset < end) {
        part.set(bytes, offset - cursor);
        return;
      }
      cursor = end;
    }
    throw new Error(`patch offset ${offset} out of range`);
  }

  toBytes(): Uint8Array {
    this.flush();
    return concatBytes(this.parts);
  }
}

function normalizePath(path: string) {
  return path.replace(/\\/g, "/");
}

/**
 * Build a League Toolkit–compatible `.modpkg` (format version 1).
 * Chunks are stored uncompressed. Works in the browser for static hosting.
 */
export async function packModpkg(input: PackModpkgInput): Promise<Uint8Array> {
  const layers = [{ name: "base", priority: 0 }];
  const layerIndex = new Map([["base", 0]]);

  const metadataBytes = new Uint8Array(
    msgpackEncode({
      schema_version: input.metadata.schema_version ?? 3,
      name: input.metadata.name,
      display_name: input.metadata.display_name,
      description: input.metadata.description ?? null,
      version: input.metadata.version,
      distributor: null,
      authors: input.metadata.authors.map((a) => ({
        name: a.name,
        role: a.role ?? null,
      })),
      license: input.metadata.license,
      tags: input.metadata.tags ?? ["champion-skin", "recolor"],
      champions: input.metadata.champions ?? [],
      maps: input.metadata.maps ?? [],
      layers: input.metadata.layers ?? [
        { name: "base", priority: 0, description: "Base layer" },
      ],
    }),
  );

  const prepared: Prepared[] = [
    {
      path: METADATA_PATH,
      pathHash: await hashPath(METADATA_PATH),
      layer: "",
      wad: "",
      data: metadataBytes,
      meta: true,
    },
  ];

  if (input.thumbnail?.length) {
    prepared.push({
      path: THUMBNAIL_PATH,
      pathHash: await hashPath(THUMBNAIL_PATH),
      layer: "",
      wad: "",
      data: input.thumbnail,
      meta: true,
    });
  }
  if (input.readme) {
    prepared.push({
      path: README_PATH,
      pathHash: await hashPath(README_PATH),
      layer: "",
      wad: "",
      data: utf8(input.readme),
      meta: true,
    });
  }
  if (input.licenseText) {
    prepared.push({
      path: LICENSE_PATH,
      pathHash: await hashPath(LICENSE_PATH),
      layer: "",
      wad: "",
      data: utf8(input.licenseText),
      meta: true,
    });
  }

  const regular: Prepared[] = [];
  for (const chunk of input.chunks) {
    const path = normalizePath(chunk.path);
    const layer = chunk.layer ?? "base";
    const wad = chunk.wad.toLowerCase();
    if (!layerIndex.has(layer)) {
      throw new Error(`Unknown layer "${layer}". v1 only supports "base".`);
    }
    regular.push({
      path,
      pathHash: await hashPath(path),
      layer,
      wad,
      data: chunk.data,
      meta: false,
    });
  }
  regular.sort(
    (a, b) => a.wad.localeCompare(b.wad) || a.layer.localeCompare(b.layer),
  );

  const all = [...prepared, ...regular];

  const paths: string[] = [];
  const pathIndex = new Map<string, number>();
  for (const c of all) {
    const key = c.path.toLowerCase();
    if (!pathIndex.has(key)) {
      pathIndex.set(key, paths.length);
      paths.push(c.path);
    }
  }

  const wads: string[] = [];
  const wadIndex = new Map<string, number>();
  for (const c of regular) {
    if (!wadIndex.has(c.wad)) {
      wadIndex.set(c.wad, wads.length);
      wads.push(c.wad);
    }
  }

  const out = new Writer();
  out.writeBytes(MAGIC);
  out.writeU32(FORMAT_VERSION);
  out.writeU32(0);
  out.writeU32(all.length);

  out.writeU32(layers.length);
  for (const layer of layers) {
    const name = utf8(layer.name);
    out.writeU32(name.length);
    out.writeBytes(name);
    out.writeI32(layer.priority);
  }

  out.writeU32(paths.length);
  for (const p of paths) out.writeCString(p);

  out.writeU32(wads.length);
  for (const wad of wads) out.writeCString(wad);

  out.align8();

  const tocOffset = out.reserve(all.length * CHUNK_RECORD_SIZE);
  const toc = new Writer();

  for (const chunk of all) {
    const stored = chunk.data;
    const checksum = await hashBytes(stored);
    const dataOffset = BigInt(out.length);

    out.writeBytes(stored);

    const pathIdx = pathIndex.get(chunk.path.toLowerCase()) ?? 0;
    const layerIdx = chunk.meta
      ? INDEX_NONE
      : (layerIndex.get(chunk.layer) ?? INDEX_NONE);
    const wadIdx = chunk.meta
      ? INDEX_NONE
      : (wadIndex.get(chunk.wad) ?? INDEX_NONE);

    toc.writeU64(chunk.pathHash);
    toc.writeU64(dataOffset);
    toc.writeU8(COMPRESSION_NONE);
    toc.writeU64(BigInt(stored.length));
    toc.writeU64(BigInt(stored.length));
    toc.writeU64(checksum);
    toc.writeU64(checksum);
    toc.writeU32(pathIdx);
    toc.writeU32(layerIdx);
    toc.writeU32(wadIdx);
  }

  out.patch(tocOffset, toc.toBytes());
  return out.toBytes();
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
