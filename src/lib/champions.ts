import starterTextures from "@/lib/starter-textures.json";
import starterMeshes from "@/lib/starter-meshes.json";
import starterSkinMaps from "@/lib/starter-skin-maps.json";
import { publicUrl } from "@/lib/public-url";

export type ChampionTexture = {
  /** Public URL for the bundled PNG */
  url: string;
  /** Path written into the .modpkg / WAD */
  exportPath: string;
};

export type ChampionOption = {
  id: string;
  name: string;
  folder: string;
  wad: string;
  starterTextureUrl: string;
  exportPath: string;
  /** Bundled SKN for UV island selection */
  sknUrl: string | null;
  /** Default diffuse (body) */
  defaultTexture: ChampionTexture;
  /**
   * Explicit submesh → texture overrides from skin0.bin materialOverride.
   * Submeshes missing here use defaultTexture.
   */
  submeshTextures: Record<string, ChampionTexture>;
  /** Submeshes hidden by default in-game (skinMeshProperties.initialSubmeshToHide). */
  hiddenSubmeshes: string[];
};

type StarterTexture = {
  id: string;
  folder: string;
  file: string;
  exportPath: string;
  source: string;
  bytes: number;
};

type StarterMesh = {
  id: string;
  folder: string;
  sknUrl: string;
  sourcePath: string;
  bytes: number;
};

type StarterSkinMap = {
  id: string;
  folder: string;
  defaultTexture: string;
  defaultFile: string;
  submeshToTexture: Record<string, string>;
  hiddenSubmeshes?: string[];
  sknSourcePath: string | null;
};

const starters = starterTextures as StarterTexture[];
const meshes = starterMeshes as StarterMesh[];
const skinMaps = starterSkinMaps as unknown as StarterSkinMap[];

function textureByExportPath(exportPath: string, folder: string): ChampionTexture {
  const hit =
    starters.find((s) => s.exportPath === exportPath) ??
    starters.find((s) => s.folder === folder && s.exportPath.endsWith(exportPath.split("/").pop()!));
  if (hit) return { url: publicUrl(hit.file), exportPath: hit.exportPath };
  // Fallback: Community Dragon-style path even if not bundled
  return {
    url: publicUrl(`/starters/${exportPath.split("/").pop()}`),
    exportPath,
  };
}

function assetsFor(id: string, folder: string) {
  const map =
    skinMaps.find((s) => s.id === id) ?? skinMaps.find((s) => s.folder === folder);
  const mesh =
    meshes.find((m) => m.id === id) ?? meshes.find((m) => m.folder === folder);
  const primary =
    starters.find((s) => s.id === id && s.file === `/starters/${folder}.png`) ??
    starters.find((s) => s.folder === folder) ??
    null;

  const defaultExport =
    map?.defaultTexture ??
    primary?.exportPath ??
    `assets/characters/${folder}/skins/base/${folder}_base_tx_cm.png`;
  const defaultTexture = textureByExportPath(defaultExport, folder);

  const submeshTextures: Record<string, ChampionTexture> = {};
  if (map) {
    for (const [sub, exportPath] of Object.entries(map.submeshToTexture)) {
      submeshTextures[sub] = textureByExportPath(exportPath, folder);
    }
  }

  return {
    starterTextureUrl: defaultTexture.url,
    exportPath: defaultTexture.exportPath,
    sknUrl: mesh?.sknUrl ? publicUrl(mesh.sknUrl) : null,
    defaultTexture,
    submeshTextures,
    hiddenSubmeshes: map?.hiddenSubmeshes ?? [],
  };
}

/** Resolve which diffuse a submesh samples. Eyes etc. fall back to default. */
export function textureForSubmesh(
  champion: ChampionOption,
  submeshName: string | null | undefined,
): ChampionTexture {
  if (submeshName && champion.submeshTextures[submeshName]) {
    return champion.submeshTextures[submeshName]!;
  }
  return champion.defaultTexture;
}

export const CHAMPIONS: ChampionOption[] = [
  { id: "Ahri", name: "Ahri", folder: "ahri", wad: "Ahri.wad.client", ...assetsFor("Ahri", "ahri") },
  { id: "Yasuo", name: "Yasuo", folder: "yasuo", wad: "Yasuo.wad.client", ...assetsFor("Yasuo", "yasuo") },
  { id: "Jinx", name: "Jinx", folder: "jinx", wad: "Jinx.wad.client", ...assetsFor("Jinx", "jinx") },
  { id: "Lux", name: "Lux", folder: "lux", wad: "Lux.wad.client", ...assetsFor("Lux", "lux") },
  { id: "Zed", name: "Zed", folder: "zed", wad: "Zed.wad.client", ...assetsFor("Zed", "zed") },
  {
    id: "MissFortune",
    name: "Miss Fortune",
    folder: "missfortune",
    wad: "MissFortune.wad.client",
    ...assetsFor("MissFortune", "missfortune"),
  },
  {
    id: "Thresh",
    name: "Thresh",
    folder: "thresh",
    wad: "Thresh.wad.client",
    ...assetsFor("Thresh", "thresh"),
  },
  {
    id: "LeeSin",
    name: "Lee Sin",
    folder: "leesin",
    wad: "LeeSin.wad.client",
    ...assetsFor("LeeSin", "leesin"),
  },
  { id: "Akali", name: "Akali", folder: "akali", wad: "Akali.wad.client", ...assetsFor("Akali", "akali") },
  { id: "KaiSa", name: "Kai'Sa", folder: "kaisa", wad: "Kaisa.wad.client", ...assetsFor("KaiSa", "kaisa") },
];

export function defaultTexturePath(champion: ChampionOption): string {
  return champion.exportPath;
}
