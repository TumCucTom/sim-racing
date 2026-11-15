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

## Car models

Detailed car bodies loaded by `attachGLB` in `src/game/carmodel.js` (per-car settings in `GLB_MODELS` there). Each car keeps
its procedural body as the loading stand-in, the ghost and the fallback. All six new files came from Sketchfab uploads whose
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
| `models/hypercar.glb` | Aurelia LMH | "AUDI R18" — https://sketchfab.com/3d-models/audi-r18-3a5f4938e662429b8633120aa62805a4 | Godheim | CC BY 4.0 | 0.32 MB, 44k |
| `models/ev.glb` | Volt-R Quad | "Generic Electric sedan vector" — https://sketchfab.com/3d-models/generic-electric-sedan-95f32d0d23bf4db48b1b28843385685f | Antonis_zks | CC BY 4.0 | 0.44 MB, 144k |

Changes made to every file (`tools/models-build.mjs`; `tools/models-preview.mjs` renders a quick check): node transforms baked
and the car re-oriented to the game's axes (+X forward, +Y up, metres, on the ground, origin at mid-wheelbase); the four wheels
cut out of the body into `wheel_fl|fr|rl|rr` nodes (the 911's steered front wheels straightened); meshes merged per material,
welded and simplified; textures re-encoded as WebP at up to 1024 px; Draco compression. Per file: the 911 lost its ground plane
and separate clear-coat shell and was scaled to a 2.45 m wheelbase; the Civic to 2.70 m; the Mustang to 2.74 m; the RC-09 to
3.05 m; the electric saloon to 2.90 m; the R18's blended body material was made opaque. At run time the game replaces paint,
glass and tyre materials on the 911 (white), Civic (blue), Mustang (red) and electric saloon (dark grey), scales each model to
the simulated wheelbase and adds brake lamps. The RC-09 and R18 keep the liveries their authors painted (including the sponsor
names on them). Brand names and badges on these models belong to their owners; the cars keep fictional names in the game.

The Mini Cooper S is still procedural, with its own body builder (`src/game/minibody.js`, original code, no third-party
asset). No openly licensed F56 model with a credible origin was found: the candidates on Sketchfab are game rips or
NonCommercial, the Mini files indexed by Objaverse-XL sit in GitHub repositories with no licence or are a CGTrader purchase,
and BlenderKit has none.

Car models add about 3.9 MB (`public/models/*.glb` is 5.6 MB including the existing Ferrari).
