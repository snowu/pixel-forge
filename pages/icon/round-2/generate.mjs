// Hand-authored pixel masters: edit the rows, then run this file with Node 18+.
// Uses the repository's PNG codec; no graphics package or build step required.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodePng } from '../../../test/png.mjs';

const out = fileURLToPath(new URL('.', import.meta.url));
const palette = { L: '#e6dcf7', P: '#b98cff', D: '#8057bd', M: '#e08cff' };
const ink = '#07040d';
import designs from './designs.mjs';

const rgb = hex => [...hex.slice(1).match(/../g)].map(n => parseInt(n, 16));
function render(design, size, maskable = false) {
  const pixels = Buffer.alloc(size * size * 4);
  const unit = maskable ? size * 3 / 64 : size / 16;
  const offset = maskable ? size / 8 : 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const sx = Math.floor((x - offset) / unit), sy = Math.floor((y - offset) / unit);
    const symbol = design.rows[sy]?.[sx];
    const color = palette[symbol] || ink;
    const corner = !maskable && ((x < unit && y < unit) || (x >= size - unit && y < unit) || (x < unit && y >= size - unit) || (x >= size - unit && y >= size - unit));
    pixels.set([...rgb(color), corner ? 0 : 255], (y * size + x) * 4);
    // All foreground must survive a circular crop of radius 40% of the maskable canvas.
    if (maskable && palette[symbol] && Math.hypot(x + .5 - size / 2, y + .5 - size / 2) > size * .4) throw Error('Unsafe maskable foreground');
  }
  return encodePng(size, size, pixels);
}

mkdirSync(out, { recursive: true });
for (const d of designs) {
  if (d.rows.length !== 16 || d.rows.some(row => row.length !== 16 || /[^.LPDM]/.test(row))) throw Error(`Invalid 16×16 master: ${d.id}`);
  const rects = d.rows.flatMap((row, y) => [...row].flatMap((c, x) => palette[c] ? [`<rect x="${x}" y="${y}" width="1" height="1" fill="${palette[c]}"/>`] : [])).join('');
  writeFileSync(`${out}${d.id}.svg`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges" role="img" aria-label="${d.name}"><path fill="${ink}" d="M1 0H15V1H16V15H15V16H1V15H0V1H1Z"/>${rects}</svg>\n`);
  for (const size of [16, 32, 48, 192, 512]) writeFileSync(`${out}${d.id}-${size}.png`, render(d, size));
  writeFileSync(`${out}${d.id}-maskable-512.png`, render(d, 512, true));
}

const card = d => `<article>
  <div class="top"><span class="letter">${d.label}</span><span>${d.theme}</span>${d.label === 'C2' ? '<b class="pick">MY PICK</b>' : ''}</div>
  <div class="hero"><img src="${d.id}-512.png" width="224" height="224" alt="${d.name}"></div>
  <h2>${d.name}</h2><p class="description">${d.description}</p>
  <div class="sizes">${[16,32,48].map(n => `<div><img src="${d.id}-${n}.png" width="${n}" height="${n}" alt="${n} pixel ${d.name}"><small>${n} px</small></div>`).join('')}<div class="app"><img class="circle" src="${d.id}-maskable-512.png" width="64" height="64" alt="Circular app crop"><small>app crop</small></div></div>
  <div class="tab dark"><img src="${d.id}-16.png" width="16" height="16" alt="">spritewright <span>×</span></div>
  <div class="tab light"><img src="${d.id}-16.png" width="16" height="16" alt="">spritewright <span>×</span></div>
  <p class="tradeoff">${d.tradeoff}</p>
</article>`;
writeFileSync(`${out}index.html`, `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Spritewright · sprite mascot studies</title><style>
*{box-sizing:border-box}body{margin:0;background:#0b0811;color:#e6dcf7;font:15px/1.5 system-ui,sans-serif}main{max-width:1480px;margin:auto;padding:48px 48px 30px}.eyebrow{color:#b98cff;font:600 12px monospace;letter-spacing:2px}header{display:flex;justify-content:space-between;align-items:end;margin:14px 0 30px}h1{font-size:40px;letter-spacing:-1.6px;line-height:1.15;margin:0 0 12px;font-weight:650}header p{color:#a99cbf;margin:0}.edition{font:12px monospace;color:#a99cbf;text-align:right;line-height:1.8}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px}article{background:#120d1c;border:1px solid #332642;padding:20px}.top{height:28px;display:flex;align-items:center;gap:10px;color:#a99cbf;font:9px monospace;letter-spacing:.2px}.letter{display:grid;place-items:center;width:30px;height:26px;background:#b98cff;color:#12081f;font:bold 14px monospace}.pick{font:8px monospace;color:#e08cff;margin-left:auto}.hero{height:260px;display:grid;place-items:center}img{image-rendering:pixelated;object-fit:contain}h2{font-size:22px;letter-spacing:-.6px;margin:0 0 10px;font-weight:600}.description{font-size:13px;color:#b9accb;height:78px;margin:0}.sizes{height:116px;display:flex;align-items:end;gap:24px;padding:16px 0;border-top:1px solid #332642;border-bottom:1px solid #332642}.sizes>div{display:flex;flex-direction:column;align-items:center;gap:9px}.sizes .app{margin-left:auto}small{font:10px monospace;color:#a99cbf;white-space:nowrap}.circle{border-radius:50%}.tab{height:39px;display:flex;align-items:center;gap:10px;padding:0 12px;font:12px system-ui;margin-top:14px;border-radius:7px 7px 0 0}.tab span{margin-left:auto;font-size:16px}.dark{background:#27232f;color:#e6dcf7}.light{margin-top:6px;background:#eeeaf2;color:#30283b}.tradeoff{font-size:12px;color:#a99cbf;margin:16px 0 0;min-height:40px}footer{margin-top:26px;display:flex;align-items:center;gap:16px;color:#a99cbf;font-size:12px}footer img{width:48px;height:48px}footer strong{color:#e6dcf7;font-weight:500}.note{margin-left:auto;text-align:right}@media(max-width:1000px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}main{padding:28px}.edition{display:none}}@media(max-width:560px){.grid{grid-template-columns:1fr}h1{font-size:32px}footer{flex-wrap:wrap}.note{text-align:left;margin:0}}
</style></head><body><main><div class="eyebrow">SPRITEWRIGHT / MASCOT EXPLORATION · ROUND 02</div><header><div><h1>A little sprite. More character.</h1><p>Three evolutions of C: simpler, more purposeful, or more expressive.</p></div><div class="edition">DIRECTION C · PR #20<br>16 × 16 MASTERS / EXISTING APP PALETTE</div></header><div class="grid">${designs.map(card).join('')}</div><footer><img src="../c-sprite-512.png" alt="Original C sprite"><div><strong>Original direction C</strong><br>Character selected for iteration</div><div class="note">Small icons shown at actual CSS sizes · dark and light tab studies<br>App previews use padded, opaque maskable exports · choose C1, C2, or C3</div></footer></main></body></html>\n`);
console.log(`Generated ${designs.length} pixel masters, SVGs, size exports, and review HTML.`);
