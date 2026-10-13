// Run from any directory with Node 18+. Pixel masters and color roles live in designs.mjs.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodePng } from '../../../../test/png.mjs';
import designs from './designs.mjs';

const out = fileURLToPath(new URL('.', import.meta.url));
const ink = '#101820';
const rgb = hex => hex.slice(1).match(/../g).map(n => parseInt(n, 16));
const all = designs;

function render(d,size,maskable=false) {
  const rgba = Buffer.alloc(size*size*4);
  const unit = maskable ? size*3/64 : size/16;
  const inset = maskable ? size/8 : 0;
  for (let y=0;y<size;y++) for (let x=0;x<size;x++) {
    const sx=Math.floor((x-inset)/unit),sy=Math.floor((y-inset)/unit);
    const symbol=d.rows[sy]?.[sx];
    const foreground=Boolean(d.colors[symbol]);
    const corner=!maskable && (x<unit || x>=size-unit) && (y<unit || y>=size-unit);
    rgba.set([...rgb(d.colors[symbol] || ink),corner ? 0 : 255],(y*size+x)*4);
    if(maskable && foreground && Math.hypot(x+.5-size/2,y+.5-size/2)>size*.4) throw Error(`Unsafe mask: ${d.id}`);
  }
  return encodePng(size,size,rgba);
}

mkdirSync(out,{recursive:true});
for(const d of all) {
  if(d.rows.length!==16 || d.rows.some(row=>row.length!==16 || [...row].some(c=>c!=='.'&&!d.colors[c]))) throw Error(`Invalid source: ${d.id}`);
  for(const size of [16,32,48,192,512]) writeFileSync(`${out}${d.id}-${size}.png`,render(d,size));
  writeFileSync(`${out}${d.id}-maskable-512.png`,render(d,512,true));
  const rects=d.rows.flatMap((row,y)=>[...row].flatMap((c,x)=>d.colors[c]?[`<rect x="${x}" y="${y}" width="1" height="1" fill="${d.colors[c]}"/>`]:[])).join('');
  writeFileSync(`${out}${d.id}.svg`,`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges" role="img" aria-label="${d.name}"><path fill="${ink}" d="M1 0H15V1H16V15H15V16H1V15H0V1H1Z"/>${rects}</svg>\n`);
}

const css=`*{box-sizing:border-box}body{margin:0;background:#101419;color:#f2f0e9;font:14px/1.5 system-ui,sans-serif}main{max-width:1480px;padding:44px 48px 30px;margin:auto}.eyebrow{font:11px monospace;letter-spacing:2px;color:#a9babf}header{display:flex;justify-content:space-between;align-items:end;margin:14px 0 30px}h1{font-size:40px;line-height:1.12;letter-spacing:-1.5px;margin:0 0 12px;font-weight:650}header p{color:#a9babf;margin:0}.edition{text-align:right;font:11px/1.8 monospace;color:#a9babf}.grid{display:grid;gap:18px;grid-template-columns:repeat(4,minmax(0,1fr))}.color .grid{grid-template-columns:repeat(3,minmax(0,1fr))}article{border:1px solid #344049;background:#182027;padding:20px}.top{display:flex;gap:12px;align-items:center;font:11px monospace;color:#bac5c5}.label{padding:5px 8px;background:#d6e4df;color:#17252d;font-weight:bold}.badge{margin-left:auto;color:#c7dccd;font-size:9px}.hero{height:248px;display:grid;place-items:center}.hero img{width:208px;height:208px}img{image-rendering:pixelated;object-fit:contain}h2{font-size:23px;line-height:1.2;letter-spacing:-.5px;margin:0 0 12px;font-weight:600}.note{height:78px;color:#bac5c5;font-size:13px;margin:0}.sizes{display:flex;align-items:end;gap:22px;height:110px;padding:14px 0;border-top:1px solid #344049}.sizes>div{display:flex;align-items:center;flex-direction:column;gap:8px}.sizes .app{margin-left:auto}.circle{border-radius:50%}small{font:10px monospace;color:#a9babf;white-space:nowrap}.tabs{display:grid;gap:6px;margin-top:12px}.tab{display:flex;align-items:center;gap:9px;height:33px;border-radius:5px 5px 0 0;padding:0 10px;background:#303940;font-size:11px}.tab.light{background:#f0eee7;color:#25333c}.tab span{margin-left:auto}.swatches{display:flex;gap:12px;margin:4px 0 14px}.swatch{display:flex;align-items:center;gap:6px;font:10px monospace;color:#bac5c5}.swatch i{display:block;width:12px;height:12px;background:var(--c)}footer{color:#a9babf;font-size:12px;margin-top:24px;display:flex;justify-content:space-between;gap:20px}footer a{color:#d6e4df}.color .hero{height:182px}.color .hero img{width:160px;height:160px}.color .note{height:48px}.color .sizes{height:91px}.color article{padding:18px 20px}.color h2{font-size:21px}.color .tabs{grid-template-columns:1fr 1fr}@media(max-width:1000px){main{padding:28px}.grid,.color .grid{grid-template-columns:repeat(2,minmax(0,1fr))}.edition{display:none}.color .note{height:70px}.color .tabs{grid-template-columns:1fr}}@media(max-width:600px){main{padding:20px}.grid,.color .grid{grid-template-columns:1fr}h1{font-size:30px}.note,.color .note{height:auto;min-height:65px}footer{flex-direction:column}.color .hero{height:210px}.color .hero img{width:192px;height:192px}}`;

function card(d,color=false) {
  return `<article><div class="top"><span class="label">${d.label}</span><span>${color?'COLOR STUDY':'SHAPE STUDY'}</span>${d.label==='S1'?'<span class="badge">WORKING SHAPE</span>':''}</div><div class="hero"><img src="${d.id}-512.png" alt="${d.name}" width="208" height="208"></div><h2>${d.name}</h2><p class="note">${d.note}</p>${color?`<div class="swatches">${[['J','FEATHER'],['F','SPINE'],['X','INK']].map(([key,name])=>`<span class="swatch"><i style="--c:${d.colors[key]}"></i>${name}</span>`).join('')}</div>`:''}<div class="sizes">${[16,32,48].map(size=>`<div><img src="${d.id}-${size}.png" width="${size}" height="${size}" alt="${d.name} at ${size} px"><small>${size} px</small></div>`).join('')}<div class="app"><img class="circle" src="${d.id}-maskable-512.png" width="64" height="64" alt="${d.name} circular app crop"><small>app crop</small></div></div><div class="tabs"><div class="tab"><img src="${d.id}-16.png" width="16" height="16" alt="">spritewright<span>×</span></div><div class="tab light"><img src="${d.id}-16.png" width="16" height="16" alt="">spritewright<span>×</span></div></div></article>`;
}
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Spritewright · quill color studies</title><style>${css}</style></head><body class="color"><main><div class="eyebrow">SPRITEWRIGHT / QUILL · ROUND 04</div><header><div><h1>Back to the quill.</h1><p>The feather returns. The six palettes stay.</p></div><div class="edition">FEATHER + SPINE + INK<br>ONE 16 × 16 MASTER / SIX PALETTES</div></header><div class="grid">${designs.map(d=>card(d,true)).join('')}</div><footer><span>Broad feather, light diagonal spine, colored nib and ink mark.<br>P1 and P3 are my preferred starting points.</span><span>16 / 32 / 48 px favicon studies · illustrative app crops<br>All six preserve the exact colors from round three.</span></footer></main></body></html>\n`;
writeFileSync(`${out}index.html`,html);
console.log('Generated six quill palettes: 36 PNG exports, six SVGs, and the review page.');
