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
