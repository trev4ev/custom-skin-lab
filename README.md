# Custom Skin Lab

Create local-only League of Legends skin recolors and export them as **`.modpkg`** files for [League Toolkit Manager](https://wiki.leaguetoolkit.dev/).

Other players never see your mods — they only change what you see on your client.

## Milestone 1 (now)

1. Pick a starter champion (bundled base textures included) **or** upload your own
2. Recolor with hue / saturation / brightness
3. Download a `.modpkg` ready for League Toolkit Manager

## Develop

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Refresh bundled starter textures from Community Dragon:

```bash
npm run fetch:starters
```

## How texture extraction works

League stores champion art inside **WAD archives** (for example `Ahri.wad.client`) under your game install. Tools unpack those archives, let you edit files, then pack a mod that overlays your changes locally.

### Easiest for this app: use starters

Starter champions ship with their **base diffuse** textures already downloaded from [Community Dragon](https://raw.communitydragon.org/) into `public/starters/`. Open the app, pick Ahri / Yasuo / etc., and recolor immediately — no extract step.

### Option A — Community Dragon (no game install)

Browse / download PNGs directly:

`https://raw.communitydragon.org/latest/game/assets/characters/<champion>/skins/base/`

Example:

`https://raw.communitydragon.org/latest/game/assets/characters/ahri/skins/base/ahri_base_tx_cm.png`

Then **Upload texture** in the lab. Keep the WAD path field matching the real asset path when you export.

### Option B — League Toolkit Workshop (from your install)

1. Install [LTK Manager](https://wiki.leaguetoolkit.dev/) and open **Creator Workshop**
2. Create or open a mod project targeting the champion
3. Import / browse the champion WAD from your League install (`Game/DATA/FINAL/...`)
4. Export or copy the diffuse texture (often `*_tx_cm` / body albedo) as PNG
5. Upload that PNG here, confirm the texture path, export `.modpkg`

Useful wiki pages:

- [How Modding Works](https://wiki.leaguetoolkit.dev/)
- [WAD Archives](https://wiki.leaguetoolkit.dev/reference/file-formats/wad/)
- [Mod Projects](https://wiki.leaguetoolkit.dev/making-mods/mod-projects/)

### What “diffuse / tx_cm” means

That’s the main color map for the champion body. Recoloring it is the fastest way to change how a skin reads in-game. Many champs also have separate maps for weapons, particles, masks, etc. — those can be added later as extra texture slots.

## Install a generated mod

1. Install LTK Manager
2. Import the downloaded `.modpkg`
3. Enable it and launch League

## Texture paths

The exporter writes textures into the champion WAD overlay using the path you set (for example `assets/characters/ahri/skins/base/ahri_base_tx_cm.png`). Starters fill this in automatically. For custom uploads, match the path you extracted for best results.

## Fast follow

- AI-assisted skin concepts → texture generation
- Multi-texture slots (body, weapon, VFX)
- Optional `.tex` conversion when Toolkit transformers land

## Stack

- Next.js + TypeScript
- Bundled Community Dragon starter textures
- Client-side canvas recoloring
- Server-side `.modpkg` packer aligned with League Toolkit format v1
