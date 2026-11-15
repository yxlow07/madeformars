# MadeForMars — deploy folder

Everything needed to run the MadeForMars web app: the front-end source, its build configuration, the app's static assets (Draco decoder and 3D models) and the baked data for all five sites and the globe (about 310 MB, 273 files, none over 21 MB). Training files (splat images and point clouds) are not included. The full project, with the Python pipelines that produce the data, is in `../marswalk-hybrid/`.

## Run

```powershell
npm install                     # Node 20+ (tested on 24)
npm run dev                     # http://localhost:5173  (left click on the splash to start)
npm run build                   # type-check + production build into dist/ (includes data/processed, data/global and data/sites)
```

The data is already in `data/`. To use a different data folder instead (e.g. after re-baking in the main project), point the dev server at it:

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
| `data/processed/` (rest), `data/sites/`, `data/global/` | the baked data (see below) |
| `runs/` | walk logs saved by the dev server (git-ignored) |

## Data included (copied from `../marswalk-hybrid/data/`)

To refresh it after re-baking, copy these same files again. The `splat/` subfolders (training images, point clouds) are **not** needed.

**`data/processed/`** (Jezero, the default site), next to `draco/` and `models/`:
`terrain.json`, `height.f32`, `slope.f32`, `cost.f32`, `ortho.jpg`, `slope.png`, `hazard.png`, `layers.json`, `pois.json`, `pois/` (stop photos), `traverse.json`, `stop.json`, `stop.spz`, `splat_transform.json`

**`data/sites/<id>/`** for each extra site (`gale-yellowknife`, `gale-gediz`, `spirit-homeplate`, `opportunity-capeyork`), with the same set of files:
`terrain.json`, `height.f32`, `slope.f32`, `cost.f32`, `ortho.jpg`, `slope.png`, `hazard.png`, `layers.json`, `pois.json`, `traverse.json`, `stop.json`, `stop.spz`, `splat_transform.json`

**`data/global/`** (the globe):
`sites.json` (site registry), `layers.json` + `layers/` (all global and weather layers, incl. `layers/wx/`), `mola.json`, `mola_4k.i16`, `slope_4k.u8`, `viking_2k.jpg`, `viking_8k.jpg`, `landmarks.json`, `missions.json`, `bases.json`, `events.json`, `geology_units.json`, `score_config.json`, `scores.json`, `stars.json`, `stars.f32`, `manifest.json`

To produce the data from scratch, use the pipelines in `../marswalk-hybrid/` (see its README): `tasks.py terrain`, `tasks.py splat`, `tasks.py global`, the per-site steps, and `pipeline/global/bake_sites.py`.

## Notes

- `npm run build` copies `data/global` and `data/sites` into `dist/` (the dev server serves them directly), so a static host such as Vercel gets the whole app. If the build log warns about Git LFS pointers, enable Git LFS on the host (Vercel: Settings → Git → Git Large File Storage) and redeploy.
- On small screens (narrower than 900 px or shorter than 500 px, i.e. phones) the app shows a "Best on a larger screen" notice instead of starting, so nothing heavy downloads. **Try anyway** starts it (remembered for the browser session); rotating or resizing to a large enough screen starts it automatically. The code is at the end of `src/app/main.ts`.
- Saving walk logs needs the dev server (`/api/runs`). A static build (`dist/`) runs without it and keeps runs in memory only.
- Data licences and credits are listed in the app (globe → Layers menu → Credits and data sources) and in `../PROJECT_REPORT.md`. The weather layers come from the Mars Climate Database (LMD / ESA / CNES): free scientific use with the source quoted, no commercial use without permission.
