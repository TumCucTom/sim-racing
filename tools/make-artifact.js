// Turns the single-file build (dist-single/index.html) into a body-only page
// suitable for publishing as a hosted artifact.
import fs from 'node:fs';
const html = fs.readFileSync('dist-single/index.html', 'utf8');
const title = html.match(/<title>[\s\S]*?<\/title>/)[0];
const styles = [...html.matchAll(/<style[^>]*>[\s\S]*?<\/style>/g)].map(m => m[0]).join('\n');
const scripts = [...html.matchAll(/<script[^>]*>[\s\S]*?<\/script>/g)].map(m => m[0]).join('\n');
let body = html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>'));
body = body.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');
const b64 = (f) => fs.readFileSync(f).toString('base64');
// Binary assets the page cannot fetch as side files (.glb, .hdr) are always embedded.
// Images (.jpg/.png) are copied next to the page as side files under their normal
// relative URLs; pass --inline-images to embed them as data: URIs instead (adds ~11 MB).
const assets = { 'models/ferrari.glb': b64('public/models/ferrari.glb'), 'env/sky_1k.hdr': b64('public/env/sky_1k.hdr') };
const images = ['models/ferrari_ao.png', 'env/sky_8k.jpg', ...fs.readdirSync('public/tex').filter(f => /\.(jpg|png)$/.test(f)).map(f => 'tex/' + f)];
const inlineImages = process.argv.includes('--inline-images');
fs.mkdirSync('artifact', { recursive: true });
for (const f of images) {
  if (inlineImages || f === 'models/ferrari_ao.png') assets[f] = `data:image/${f.endsWith('.png') ? 'png' : 'jpeg'};base64,` + b64('public/' + f);
  if (!inlineImages) { fs.mkdirSync('artifact/' + f.split('/')[0], { recursive: true }); fs.copyFileSync('public/' + f, 'artifact/' + f); }
}
const inline = `<script>window.__INLINE_ASSETS=${JSON.stringify(assets)};</script>`;
const out = `${title}\n<meta name="claude:viewport-fit-sides" content="cover">\n${styles}\n${body}\n${inline}\n${scripts}\n`;
fs.mkdirSync('artifact', { recursive: true });
fs.writeFileSync('artifact/racing-sim.html', out);
console.log('artifact/racing-sim.html', (out.length / 1024).toFixed(0), 'kB', inlineImages ? '(images inlined)' : `+ ${images.length} side files under artifact/`);
