// Quick look at a .glb outside the game: three views on a neutral backdrop,
// with a red arrow along +X (the game's forward axis) and a 1 m ground grid.
//   node tools/models-preview.mjs <out.png> <model.glb> [more.glb ...]
// Needs the Vite dev server (it borrows three.js and the Draco decoder from it).
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire('/opt/node-tools/node_modules/');
const { chromium } = require('playwright');
const [out, ...files] = process.argv.slice(2);
const origin = `http://127.0.0.1:${process.env.PORT || 5173}`;
const src = await (await fetch(origin + '/src/game/carmodel.js')).text();
const dep = (name) => src.match(new RegExp(`"(/node_modules/\\.vite/deps/${name}[^"]*)"`))[1];
const urls = { three: dep('three\\.js'), gltf: dep('three_addons_loaders_GLTFLoader'), draco: dep('three_addons_loaders_DRACOLoader') };
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const W = 640, H = 400;
const p = await b.newPage({ viewport: { width: W * 3, height: H * files.length }, deviceScaleFactor: 1 });
p.on('pageerror', e => console.log('[pageerror] ' + e.message));
p.on('console', m => { if (m.type() === 'error') console.log('[error] ' + m.text()); });
await p.route('**/__models_preview.html', r => r.fulfill({ contentType: 'text/html', body: '<body style="margin:0;background:#fff"></body>' }));
await p.route('**/__m/*', r => r.fulfill({ contentType: 'model/gltf-binary', body: fs.readFileSync(files[+r.request().url().split('/').pop()]) }));
await p.goto(origin + '/__models_preview.html');
const info = await p.evaluate(async ({ urls, n, W, H }) => {
  const THREE = await import(urls.three), { GLTFLoader } = await import(urls.gltf), { DRACOLoader } = await import(urls.draco);
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(W * 3, H * n); renderer.setScissorTest(true); renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping;
  document.body.appendChild(renderer.domElement);
  const loader = new GLTFLoader(); const d = new DRACOLoader(); d.setDecoderPath('/draco/'); loader.setDRACOLoader(d);
  const pm = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene(); envScene.background = new THREE.Color(0xbfd4ea);
  const g = new THREE.Mesh(new THREE.SphereGeometry(50, 16, 8, 0, 6.3, Math.PI / 2, Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x6a6a66, side: THREE.BackSide })); envScene.add(g);
  const sun = new THREE.Mesh(new THREE.SphereGeometry(6), new THREE.MeshBasicMaterial({ color: 0xffffff })); sun.position.set(20, 35, 10); envScene.add(sun);
  const env = pm.fromScene(envScene).texture;
  const out = [];
  for (let i = 0; i < n; i++) {
    const gltf = await loader.loadAsync('/__m/' + i);
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0x9aa3ad); scene.environment = env;
    scene.add(new THREE.DirectionalLight(0xffffff, 2.5).translateX(4).translateY(8).translateZ(3));
    scene.add(gltf.scene);
    const box = new THREE.Box3().setFromObject(gltf.scene), c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3()), r = Math.max(s.x, s.y, s.z);
    const grid = new THREE.GridHelper(Math.ceil(r) * 2, Math.ceil(r) * 2, 0x333333, 0x666666); grid.position.set(Math.round(c.x), box.min.y, Math.round(c.z)); scene.add(grid);
    scene.add(new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(c.x, box.max.y + r * 0.08, c.z), r * 0.5, 0xff0000, r * 0.1, r * 0.05));
    let tris = 0; const mats = new Set(), names = [];
    gltf.scene.traverse(o => { if (o.isMesh) { tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; mats.add(o.material.name); } });
    for (const ch of gltf.scene.children) names.push(ch.name);
    const cam = new THREE.PerspectiveCamera(32, W / H, r * 0.01, r * 50);
    [[0.75, 0.42, 1.0], [-0.8, 0.3, -1.0], [0.001, 0.12, 1.25]].forEach(([dx, dy, dz], v) => {
      const dir = new THREE.Vector3(dx, dy, dz).normalize();
      cam.position.copy(c).addScaledVector(dir, r * 1.75); cam.lookAt(c);
      renderer.setViewport(v * W, (n - 1 - i) * H, W, H); renderer.setScissor(v * W, (n - 1 - i) * H, W, H); renderer.render(scene, cam);
    });
    out.push({ file: i, tris, size: s.toArray().map(v => +v.toFixed(3)), min: box.min.toArray().map(v => +v.toFixed(3)), children: names.slice(0, 12), materials: [...mats].slice(0, 60) });
  }
  return out;
}, { urls, n: files.length, W, H });
await p.screenshot({ path: out, timeout: 300000 });
info.forEach((o, i) => console.log(files[i], JSON.stringify(o)));
await b.close();
