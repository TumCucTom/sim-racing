// Turns the single-file build (dist-single/index.html) into a body-only page
// suitable for publishing as a hosted artifact.
import fs from 'node:fs';
const html = fs.readFileSync('dist-single/index.html', 'utf8');
const title = html.match(/<title>[\s\S]*?<\/title>/)[0];
const styles = [...html.matchAll(/<style[^>]*>[\s\S]*?<\/style>/g)].map(m => m[0]).join('\n');
const scripts = [...html.matchAll(/<script[^>]*>[\s\S]*?<\/script>/g)].map(m => m[0]).join('\n');
let body = html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>'));
body = body.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');
const out = `${title}\n<meta name="claude:viewport-fit-sides" content="cover">\n${styles}\n${body}\n${scripts}\n`;
fs.mkdirSync('artifact', { recursive: true });
fs.writeFileSync('artifact/racing-sim.html', out);
console.log('artifact/racing-sim.html', (out.length / 1024).toFixed(0), 'kB');
