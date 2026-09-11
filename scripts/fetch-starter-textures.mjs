#!/usr/bin/env node
/**
 * Refresh bundled starter textures + submesh→texture maps from Community Dragon.
 * Usage: npm run fetch:starters
 *
 * Mapping source: skin0.bin.json → skinMeshProperties.texture (default) and
 * materialOverride[].texture / Material→Diffuse_Texture (per submesh).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const champions = [
  ["Ahri", "ahri"],
  ["Yasuo", "yasuo"],
  ["Jinx", "jinx"],
  ["Lux", "lux"],
  ["Zed", "zed"],
  ["MissFortune", "missfortune"],
  ["Thresh", "thresh"],
  ["LeeSin", "leesin"],
  ["Akali", "akali"],
  ["KaiSa", "kaisa"],
];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public", "starters");
mkdirSync(outDir, { recursive: true });

async function fetchBuf(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "custom-skin-lab/0.1" },
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, type: res.headers.get("content-type") || "" };
}

function findSkinMeshProperties(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (
    obj.skinMeshProperties &&
    typeof obj.skinMeshProperties === "object" &&
    obj.skinMeshProperties.simpleSkin
  ) {
    return obj.skinMeshProperties;
  }
  if (Array.isArray(obj)) {
    for (const v of obj) {
      const hit = findSkinMeshProperties(v);
      if (hit) return hit;
    }
    return null;
  }
  for (const v of Object.values(obj)) {
    const hit = findSkinMeshProperties(v);
    if (hit) return hit;
  }
  return null;
}

function findMaterialNode(obj, matPath) {
  if (!matPath || !obj || typeof obj !== "object") return null;
  if (Object.prototype.hasOwnProperty.call(obj, matPath)) return obj[matPath];
  if (obj.name === matPath && obj.samplerValues) return obj;
  if (Array.isArray(obj)) {
    for (const v of obj) {
      const hit = findMaterialNode(v, matPath);
      if (hit) return hit;
    }
    return null;
  }
  for (const v of Object.values(obj)) {
    const hit = findMaterialNode(v, matPath);
    if (hit) return hit;
  }
  return null;
}

function extractDiffuse(mat) {
  if (!mat || typeof mat !== "object") return null;
  for (const s of mat.samplerValues || []) {
    if (
      s &&
      typeof s === "object" &&
      ["Diffuse_Texture", "DiffuseTexture", "Diffuse"].includes(s.TextureName)
    ) {
      return s.texturePath || null;
    }
  }
  if (mat.dynamicMaterial) return extractDiffuse(mat.dynamicMaterial);
  return null;
}

function texToPngPath(texPath) {
  return texPath.replace(/\.tex$/i, ".png");
}

function localFileFor(folder, exportPath) {
  const base = exportPath.split("/").pop().replace(/\.png$/i, "");
  // Keep primary as folder.png for stable URLs; others get full base name
  if (base === `${folder}_base_tx_cm` || base === `${folder}_base_cm_tx`) {
    return `/starters/${folder}.png`;
  }
  return `/starters/${base}.png`;
}

function diskPathFor(urlPath) {
  return join(root, "public", urlPath.replace(/^\//, ""));
}

const textureManifest = [];
const skinMaps = [];
const downloaded = new Map(); // exportPath -> { file, bytes, source }

async function ensureTexture(folder, id, exportPathPng) {
  if (downloaded.has(exportPathPng)) return downloaded.get(exportPathPng);
  const source = `https://raw.communitydragon.org/latest/game/${exportPathPng}`;
  const { buf, type } = await fetchBuf(source);
  if (!type.startsWith("image/") || buf.length < 1000) {
    throw new Error(`bad image ${exportPathPng}: ${type} ${buf.length}`);
  }
  const file = localFileFor(folder, exportPathPng);
  writeFileSync(diskPathFor(file), buf);
  const entry = {
    id,
    folder,
    file,
    exportPath: exportPathPng,
    source,
    bytes: buf.length,
  };
  downloaded.set(exportPathPng, entry);
  textureManifest.push(entry);
  console.log("  tex", file, buf.length);
  return entry;
}

for (const [id, folder] of champions) {
  console.log(id);
  const binUrl = `https://raw.communitydragon.org/latest/game/data/characters/${folder}/skins/skin0.bin.json`;
  const { buf } = await fetchBuf(binUrl);
  const skin = JSON.parse(buf.toString("utf8"));
  const smp = findSkinMeshProperties(skin);
  if (!smp?.texture) {
    throw new Error(`No default texture for ${folder}`);
  }

  const defaultTex = texToPngPath(smp.texture);
  await ensureTexture(folder, id, defaultTex);

  /** @type {Record<string, string>} submesh -> exportPath png */
  const submeshToTexture = {};

  for (const ov of smp.materialOverride || []) {
    const sub = ov.submesh;
    if (!sub) continue;
    let tex = ov.texture || null;
    if (!tex && (ov.Material || ov.material)) {
      const node = findMaterialNode(skin, ov.Material || ov.material);
      tex = extractDiffuse(node);
    }
    if (!tex) continue;
    // Skip particle/mask atlases that aren't useful diffuse edits
    if (/particles\//i.test(tex) || /mask|scroll/i.test(tex)) {
      console.log("  skip non-diffuse", sub, tex);
      continue;
    }
    const png = texToPngPath(tex);
    try {
      await ensureTexture(folder, id, png);
      submeshToTexture[sub] = png;
    } catch (err) {
      console.warn("  skip missing", sub, png, err.message);
    }
  }

  const hideRaw = smp["initialSubmeshToHide"] || "";
  const hiddenSubmeshes = String(hideRaw)
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  skinMaps.push({
    id,
    folder,
    defaultTexture: defaultTex,
    defaultFile: downloaded.get(defaultTex).file,
    /** Submeshes without an entry use defaultTexture */
    submeshToTexture,
    hiddenSubmeshes,
    sknSourcePath: smp.simpleSkin || null,
  });
}

writeFileSync(
  join(root, "src/lib/starter-textures.json"),
  `${JSON.stringify(textureManifest, null, 2)}\n`,
);
writeFileSync(
  join(root, "src/lib/starter-skin-maps.json"),
  `${JSON.stringify(skinMaps, null, 2)}\n`,
);
console.log(
  `Wrote ${textureManifest.length} textures, ${skinMaps.length} skin maps`,
);
