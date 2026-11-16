# Third-party assets

Every external file used by the renderer, where it came from and under what terms.
All loads go through `src/game/assets.js` (or `loadGLB` in `src/game/carmodel.js`), which
first looks in `window.__INLINE_ASSETS` so the hosted single-file build works; if a file is
missing the game falls back to the procedural version of that material.

| File (under `public/`) | Source | Author | Licence | Notes |
|---|---|---|---|---|
| `env/sky_1k.hdr` | Poly Haven — "Kloofendal 48d Partly Cloudy (Pure Sky)", 1k HDR — https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky (`https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/kloofendal_48d_partly_cloudy_puresky_1k.hdr`) | Greg Zaal / Poly Haven | CC0 1.0 | Image-based lighting. At load the sun is measured and removed, and the lower hemisphere replaced by a ground bounce colour (`src/game/sky.js`). |
| `env/sky_8k.jpg` | Same HDRI, tone-mapped 8k JPG (`https://dl.polyhaven.org/file/ph-assets/HDRIs/extra/Tonemapped%20JPG/kloofendal_48d_partly_cloudy_puresky.jpg`) | Greg Zaal / Poly Haven | CC0 1.0 | Visible sky. Cropped to the upper hemisphere (8192×2048), re-encoded at JPEG q88. |
| `tex/asphalt_diff.jpg`, `tex/asphalt_nor.jpg`, `tex/asphalt_rough.jpg` | Poly Haven — "Clean Asphalt" — https://polyhaven.com/a/clean_asphalt (diff + nor_gl 2k, rough 1k) | Poly Haven | CC0 1.0 | Re-encoded JPEG; roughness converted to greyscale. |
| `tex/asphalt_old_diff.jpg` | Poly Haven — "Asphalt 02" — https://polyhaven.com/a/asphalt_02 (diff 2k) | Poly Haven | CC0 1.0 | Downscaled to 1k; used for older, cracked stretches of track. |
| `tex/grass_diff.jpg`, `tex/grass_nor.jpg` | ambientCG — "Grass004" 1K-JPG — https://ambientcg.com/view?id=Grass004 | Lennart Demes / ambientCG | CC0 1.0 | Colour + OpenGL normal map. |
| `tex/gravel_diff.jpg`, `tex/gravel_nor.jpg` | ambientCG — "Gravel023" 1K-JPG — https://ambientcg.com/view?id=Gravel023 | Lennart Demes / ambientCG | CC0 1.0 | Colour + OpenGL normal map. |
| `tex/concrete_diff.jpg` | ambientCG — "Concrete034" 1K-JPG — https://ambientcg.com/view?id=Concrete034 | Lennart Demes / ambientCG | CC0 1.0 | Kerbs, pavement, walls, buildings' ground. |
| `tex/trees_atlas.png` | Poly Haven model preview renders (`https://cdn.polyhaven.com/asset_img/primary/<id>.png`) of `fir_tree_01`, `fir_sapling_medium`, `tree_small_02`, `island_tree_01`, `jacaranda_tree`, `pine_tree_01` — https://polyhaven.com/models | Poly Haven (models by Rico Cilliers and others) | CC0 1.0 | Individual trees cut out, colour-bled and packed into a 2048×1024 atlas of 8 tiles for impostor cards (the source models are 40–950 MB each, far too heavy to ship). |
| `models/ferrari.glb`, `models/ferrari_ao.png`, `draco/*` | three.js examples (pre-existing in this repo) | "Ferrari 458 Italia" by vicent091036 (Sketchfab), via three.js; Draco decoder by Google | CC BY 4.0 (model), Apache-2.0 (Draco) | Not added by the rendering overhaul; listed for completeness. |

Everything else (armco, tyre walls, debris fence, facades, labels, kerb paint, road markings, car bodies) is generated procedurally in `src/game/textures.js`, `src/game/world.js` and `src/game/carmodel.js`.

Total added download: about 11 MB (`public/env` 3.0 MB, `public/tex` 7.4 MB).

## Weather and time of day

No files were added for the weather conditions (golden hour, overcast, rain, storm, dusk). Their skies, clouds, light shafts,
rain, puddles, spray, lens droplets and the rain / spray / thunder sounds are all generated in code: `src/game/skygen.js`
(sky panorama and environment map), `src/game/wx.js` (the conditions), `src/game/weather.js`, `src/game/world.js`
(wet-surface shading) and `src/audio/weather.js`. Only the clear day uses the photographed Poly Haven sky listed above.

## Car models

Detailed car bodies loaded by `attachGLB` in `src/game/carmodel.js` (per-car settings in `GLB_MODELS` there). Each car keeps
its procedural body as the loading stand-in, the ghost and the fallback. All nine files below came from Sketchfab uploads whose
licence is recorded both on the model page and inside the downloaded file (`asset.extras`: author, license, source, title —
kept in the shipped `.glb`). Sketchfab's download API needs a login, so the files were fetched from the Objaverse 1.0 mirror
(Allen Institute for AI, `https://huggingface.co/datasets/allenai/objaverse`, path `glbs/<group>/<sketchfab uid>.glb`), which
redistributes them under the same licences.

| File (under `public/`) | Car in the game | Source | Author | Licence | Size, triangles |
|---|---|---|---|---|---|
| `models/gt3.glb` | Arrow GT3-R | "(FREE) Porsche 911 Carrera 4S" — https://sketchfab.com/3d-models/free-porsche-911-carrera-4s-d01b254483794de3819786d93e0e1ebf | Karol Miklas | **CC BY-SA 4.0** (the modified file is shared under the same licence) | 0.72 MB, 108k |
| `models/hatch.glb` | Vanta RS | "Honda Civic Type-R" — https://sketchfab.com/3d-models/honda-civic-type-r-770a5c9b025449f59769d8cd27d915bb | shindedhirendra780 | CC BY 4.0 | 0.55 MB, 172k |
| `models/coupe.glb` | Brawler GT 5.0 | "'67 Mustang (High poly)" — https://sketchfab.com/3d-models/67-mustang-high-poly-4223fcc87baa4ac58be2910a5367d7d0 | Nick Broad | CC BY 4.0 | 0.74 MB, 138k |
| `models/formula.glb` | FX-10 | "RaceCar RC-09 (Re-imagined model)" — https://sketchfab.com/3d-models/racecar-rc-09-re-imagined-model-a56b6fdcf3b742758b7c37f1e181004d | Dahie (original model and tyres based on work by Enzojz, as credited by the author) | CC BY 4.0 | 1.14 MB, 91k |
| `models/lmp1.glb` | Audi R18 e-tron quattro | "AUDI R18" — https://sketchfab.com/3d-models/audi-r18-3a5f4938e662429b8633120aa62805a4 | Godheim | CC BY 4.0 | 0.32 MB, 44k |
| `models/ev.glb` | Volt-R Quad | "Generic Electric sedan vector" — https://sketchfab.com/3d-models/generic-electric-sedan-95f32d0d23bf4db48b1b28843385685f | Antonis_zks | CC BY 4.0 | 0.44 MB, 144k |
| `models/r8lms.glb` | Audi R8 LMS GT3 | "Audi R8" (second-generation road car) — https://sketchfab.com/3d-models/audi-r8-57c798d774004b38a1a08f62f9c76651 | jasonjliang | CC BY 4.0 | 0.43 MB, 48k |
| `models/huracan.glb` | Lamborghini Huracán GT3 | "Lamborghini huracan" (road car) — https://sketchfab.com/3d-models/lamborghini-huracan-dc5d8c922ada44cc87d4bd4f7d147929 | jkazulyblanco | CC BY 4.0 | 0.71 MB, 96k |
| `models/amggt3.glb` | Mercedes-AMG GT3 | "Mercedes Benz AMG GT" (road car) — https://sketchfab.com/3d-models/mercedes-benz-amg-gt-661dcab94455463784651a3ebc63cfb9 | Yan Carvalho (carvalhoyan) | CC BY 4.0 | 0.50 MB, 87k |

Changes made to every file (`tools/models-build.mjs`; `tools/models-preview.mjs` renders a quick check): node transforms baked
and the car re-oriented to the game's axes (+X forward, +Y up, metres, on the ground, origin at mid-wheelbase); the four wheels
cut out of the body into `wheel_fl|fr|rl|rr` nodes (the 911's steered front wheels straightened); meshes merged per material,
welded and simplified; textures re-encoded as WebP at up to 1024 px; Draco compression. Per file: the 911 lost its ground plane
and separate clear-coat shell and was scaled to a 2.45 m wheelbase; the Civic to 2.70 m; the Mustang to 2.74 m; the RC-09 to
3.05 m; the electric saloon to 2.90 m; the R18's blended body material was made opaque. At run time the game replaces paint,
glass and tyre materials on the 911 (white), Civic (blue), Mustang (red) and electric saloon (dark grey), scales each model to
the simulated wheelbase and adds brake lamps. The RC-09 and R18 keep the liveries their authors painted (including the sponsor
names on them). Brand names and badges on these models belong to their owners; the cars keep fictional names in the game.

**GT3 cars added in 0.9.0.** The three files above are road cars, not the GT3 race versions: the game bolts a
code-generated race kit onto them (front splitter, side skirts, diffuser strakes, a swan-neck rear wing in the car's accent
colour; `raceKit` in `src/game/carmodel.js`, `kit` in `GLB_MODELS`). Changes by `tools/models-build.mjs`: the R8 lost its
ground plane, its two blended materials were made opaque (so the windows are dark, not see-through) and, because tyres and
trim share one material, its wheels were found from four hand-measured cylinders (`tyre.cyl`); the AMG GT sat at an angle in
its file and was turned by 12.65° (`yaw`), its ground plane dropped, and at run time its paint (silver), glass, tyres and
tail lights are re-materialled; the Huracán's body material was made opaque and it keeps the orange its author painted. All
three had their steered front wheels straightened and are scaled at run time to the simulated wheelbases (2.65 / 2.645 /
2.665 m). The author, licence, source and title are in each file's `asset.extras` and were checked against the Sketchfab
model pages' API records (description "My first time completing a full car"; "made in maya and substance painter" with Maya
`lambertNSG` material names; "feito no Blender" with Blender `Material.NNN` names).

The **Ferrari 296 GT3 and McLaren 720S GT3 are procedural** (lofted mid-engined body `gtmid` plus the same race kit, red
with a yellow stripe / papaya with a blue stripe): Objaverse 1.0 predates the 296, and the only openly licensed 720S found
there (888k faces, no description, nothing to show the uploader made it) did not meet the bar. Rejected for the same reason:
two uploads titled "Audi R8 LMS GT3" with identical 476,358-face meshes under different user names (a rip), an "Audi R8 Lms"
with a real team's sponsor livery whose low-poly, texture-mapped style looks like a racing-game mod (origin not provable
either way), and an "AMG GT Black Series" that its own description calls an edit of an existing free model. Other GT3-titled
uploads in the search results were not examined further once a credible road-car model had been found.

**Road Lamborghinis (0.9.0).** The Huracán LP 610-4 shows `models/huracan.glb` exactly as built, without the race kit:
jkazulyblanco's model is that road car. The Aventador SVJ is procedural (the mid-engined loft with a fixed wing, splitter and
diffuser, green). Candidates looked at for it and for other Lamborghinis, none used: "Lamborghini Aventador SVJ SDC (FREE)"
and the Centenario / Sián / Countach / Urus / Terzo Millennio uploads of the same account (Lambo_SC04: dozens of
500k-1M-face cars with full interiors within a year, descriptions that point to a second "all is free" account, nothing
that shows the uploader modelled them) — rejected as not credibly original; "Lamborghini Gallardo" by savelliy07 (82k faces,
tagged as a Blender model, description copied from an encyclopedia) and the other Huracán uploads — plausible but not
downloaded or vetted, because the page-size budget was already spent.

The Mini Cooper S is still procedural, with its own body builder (`src/game/minibody.js`, original code, no third-party
asset). No openly licensed F56 model with a credible origin was found: the candidates on Sketchfab are game rips or
NonCommercial, the Mini files indexed by Objaverse-XL sit in GitHub repositories with no licence or are a CGTrader purchase,
and BlenderKit has none.

Car models add about 5.5 MB (`public/models/*.glb` is 7.2 MB including the existing Ferrari; the three files added in 0.9.0 are 1.65 MB). The hosted single-file page embeds every `.glb` as base64 and is 14.6 MB with these; there is no room under the 15 MB target for another car model.

## Trackside data (kerbs, run-off, gravel, barriers) and Laguna Seca
No image or model files were added for the trackside work: kerb paint, astro-turf, paved run-off,
gravel furrows, belting, TecPro blocks and tyre stacks are drawn procedurally in `src/game/world.js`
on top of the existing CC0 textures above.

| Data | Source | Licence | Notes |
|---|---|---|---|
| `trackside.osm` in `src/sim/tracks/{silverstone,spa,monza,nordschleife,laguna}.json` (gravel beds, barrier lines) | OpenStreetMap contributors, extracted with `api/0.6/map` in November 2026 and processed by `tools/trackside-osm.mjs` | ODbL 1.0 | Derived database: ray-cast offsets from the centreline, not the original geometry. |
| `src/sim/tracks/laguna.json` centreline | OpenStreetMap contributors: `highway=raceway` ways 10464852 and 1315957502–1315957508 | ODbL 1.0 | Resampled every 5 m. |
| `src/sim/tracks/laguna.json` elevation | USGS 3D Elevation Program 1/3 arc-second DEM (`ned10m`) via opentopodata.org | US public domain | Sampled every 10 m along the lap. |
| `src/sim/tracks/monaco.scene.json` (building footprints and heights, coastline, tunnel range) | OpenStreetMap contributors, processed by `tools/monaco-scene.mjs` | ODbL 1.0 | 71 kB; façades, roofs, yachts are procedural. |
| `src/sim/tracks/*.trackside.json` | Written by hand from memory of the venues | project licence | Not surveyed; see README "Trackside". |


## Monaco

No image or model files were added for the Monaco rebuild. Its data lives in `src/sim/tracks/monaco.scene.json` (about 140 kB,
bundled with the page), written by `tools/monaco-scene.mjs`:

| Data | Source | Licence |
|---|---|---|
| Building footprints, levels / heights where tagged, coastline, piers, pools, parks, streets, steps, retaining walls, the tunnel extent | OpenStreetMap contributors — `api.openstreetmap.org/api/0.6/map` extracts covering 7.411–7.435 °E, 43.726–43.746 °N | ODbL 1.0 (credited in the game's track source line) |
| Relief (`tools/monaco-cfg/dem.json`: 50 m grid round the circuit, 250 m grid round the principality) | NASA SRTM 30 m via opentopodata.org | Public domain |

Everything drawn from that data is procedural (`src/game/monaco.js`, `monaco-props.js`, `monaco-tex.js`): the façade texture
array (Belle Époque, plain stucco, balcony-band and loggia towers, curtain wall, shop fronts, arcades, stonework, cornices,
roof tiles, zinc and copper roofs, grandstand crowd), the hoardings (fictional brands), palms, yachts, street lamps, the sea
shader and the tunnel. Garden trees reuse `tex/trees_atlas.png`; ground surfaces reuse the asphalt, grass and concrete scans
listed above. Untagged building heights are guessed from tagged neighbours and footprint size; the Casino, Hôtel de Paris,
Fairmont and a few other landmarks have hand-set heights and looks (`MARKS` in `monaco-props.js`).
