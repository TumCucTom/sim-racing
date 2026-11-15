// Loading of external (photographic) assets. Everything goes through here so
// that hosted single-file builds can serve assets embedded in
// `window.__INLINE_ASSETS` (see tools/make-artifact.js): images as data: URIs,
// binaries as raw base64. Every loader resolves to null on failure so callers
// can keep their procedural fallback.
import * as THREE from 'three';

const inline = (url) => globalThis.__INLINE_ASSETS?.[url];
const texCache = new Map(), binCache = new Map();
let texLoader = null;

export function loadBinary(url) {
  if (!binCache.has(url)) {
    const data = inline(url);
    let p;
    if (data) {
      p = Promise.resolve().then(() => {
        const bin = atob(data.replace(/^data:[^,]*,/, '')), buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        return buf.buffer;
      });
    } else p = fetch(url).then(r => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.arrayBuffer(); });
    binCache.set(url, p.catch(() => null));
  }
  return binCache.get(url);
}

// Resolves to a THREE.Texture (shared, cached) or null.
export function loadTexture(url, { srgb = true, repeat = true, aniso = 8, flipY = true } = {}) {
  if (!texCache.has(url)) {
    texLoader ??= new THREE.TextureLoader();
    texCache.set(url, new Promise((resolve) => {
      texLoader.load(inline(url) || url, (t) => {
        if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.anisotropy = aniso; t.flipY = flipY;
        t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        t.userData.shared = true;
        resolve(t);
      }, undefined, () => resolve(null));
    }));
  }
  return texCache.get(url);
}

// Swap a photographic texture into material slots once it has loaded.
// `slots` maps material property -> [url, options].
export function applyTextures(material, slots, onDone) {
  const jobs = Object.entries(slots).map(([prop, [url, opts]]) => loadTexture(url, opts).then((t) => {
    if (!t || material.userData.disposed) return false;
    material[prop] = t; return true;
  }));
  return Promise.all(jobs).then((ok) => { material.needsUpdate = true; onDone?.(ok.every(Boolean)); return ok.every(Boolean); });
}

export const ASSETS = {
  skyHDR: 'env/sky_1k.hdr',
  skyJPG: 'env/sky_8k.jpg',
  asphaltDiff: 'tex/asphalt_diff.jpg', asphaltNor: 'tex/asphalt_nor.jpg', asphaltRough: 'tex/asphalt_rough.jpg', asphaltOld: 'tex/asphalt_old_diff.jpg',
  grassDiff: 'tex/grass_diff.jpg', grassNor: 'tex/grass_nor.jpg',
  gravelDiff: 'tex/gravel_diff.jpg', gravelNor: 'tex/gravel_nor.jpg', concrete: 'tex/concrete_diff.jpg',
  trees: 'tex/trees_atlas.png',
};
