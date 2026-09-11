import { xxhash3, xxhash64 } from "hash-wasm";

/** xxHash64 (seed 0) of the ASCII-lowercased chunk path. */
export async function hashPath(path: string): Promise<bigint> {
  const canonical = path.replace(/\\/g, "/").toLowerCase();
  const hex = await xxhash64(canonical, 0);
  return BigInt(`0x${hex}`);
}

/** xxHash3 of an ASCII-lowercased name (layers & WAD ids). */
export async function hashName(name: string): Promise<bigint> {
  const hex = await xxhash3(name.toLowerCase());
  return BigInt(`0x${hex}`);
}

/** xxHash3 of raw bytes (chunk checksums). */
export async function hashBytes(data: Uint8Array): Promise<bigint> {
  const hex = await xxhash3(data);
  return BigInt(`0x${hex}`);
}
