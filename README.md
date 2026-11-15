# MadeForMars — deploy folder

The minimum needed to run the MadeForMars web app: the front-end source, its build configuration and the app's own static assets (Draco decoder and 3D models). **No mission data is included.** The full project, with the Python pipelines that produce the data, is in `../marswalk-hybrid/`.

## Run

```powershell
npm install                     # Node 20+ (tested on 24)
npm run dev                     # http://localhost:5173  (left click on the splash to start)
npm run build                   # type-check + production build into dist/
```

The app shows nothing useful until the data folders below are filled. Either copy the baked data in, or point the dev server at an existing data folder without copying:

```powershell
$env:MFM_DATA_DIR="../marswalk-hybrid/data"; npm run dev
```

## What is here

| Path | What it is |
| --- | --- |
| `index.html`, `src/` | the app (TypeScript + three.js + Spark), with the logo in `src/app/assets/` |
| `phase1.html` | the older Phase 1 viewer page (also a build input) |
| `package.json`, `package-lock.json`, `tsconfig.json` | dependencies and compiler settings, identical to the main project |
| `vite.config.ts` | dev server: serves `data/processed` at `/`, `data/global` at `/global/`, `data/sites` at `/sites/`, and the walk-log API `/api/runs` (saves to `runs/`) |
| `data/processed/draco/` | Draco mesh decoder (needed to load the 3D models) |
| `data/processed/models/` | `hdu1.glb` (habitat), `sev.glb` (pressurised rover), `astronaut_marswalk.glb` (rigged walking astronaut) |
| `data/global/`, `data/sites/`, `runs/` | empty: data goes here (see below) |

## Data to add (copy from `../marswalk-hybrid/data/` after baking)

Copy only these files. The `splat/` subfolders (training images, point clouds) are **not** needed. In total this is about 310 MB, with no single file over 21 MB.

**`data/processed/`** (Jezero, the default site), next to `draco/` and `models/`:
`terrain.json`, `height.f32`, `slope.f32`, `cost.f32`, `ortho.jpg`, `slope.png`, `hazard.png`, `layers.json`, `pois.json`, `pois/` (stop photos), `traverse.json`, `stop.json`, `stop.spz`, `splat_transform.json`

**`data/sites/<id>/`** for each extra site (`gale-yellowknife`, `gale-gediz`, `spirit-homeplate`, `opportunity-capeyork`), with the same set of files:
`terrain.json`, `height.f32`, `slope.f32`, `cost.f32`, `ortho.jpg`, `slope.png`, `hazard.png`, `layers.json`, `pois.json`, `traverse.json`, `stop.json`, `stop.spz`, `splat_transform.json`

**`data/global/`** (the globe):
`sites.json` (site registry), `layers.json` + `layers/` (all global and weather layers, incl. `layers/wx/`), `mola.json`, `mola_4k.i16`, `slope_4k.u8`, `viking_2k.jpg`, `viking_8k.jpg`, `landmarks.json`, `missions.json`, `bases.json`, `events.json`, `geology_units.json`, `score_config.json`, `scores.json`, `stars.json`, `stars.f32`, `manifest.json`

To produce the data from scratch, use the pipelines in `../marswalk-hybrid/` (see its README): `tasks.py terrain`, `tasks.py splat`, `tasks.py global`, the per-site steps, and `pipeline/global/bake_sites.py`.

## Notes

- Saving walk logs needs the dev server (`/api/runs`). A static build (`dist/`) runs without it and keeps runs in memory only.
- Data licences and credits are listed in the app (globe → Layers menu → Credits and data sources) and in `../PROJECT_REPORT.md`. The weather layers come from the Mars Climate Database (LMD / ESA / CNES): free scientific use with the source quoted, no commercial use without permission.
