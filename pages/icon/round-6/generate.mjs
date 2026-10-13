// PNGs are the editable masters. This exporter never rewrites the *-32.png inputs.
import {readFileSync,writeFileSync} from 'node:fs';
import {encodePng,decodePng} from '../../../test/png.mjs';
const dir=new URL('./',import.meta.url);
const designs=[
 ['q0-current','Current','The detailed original','The existing icon: a split feather, lively ink trail and a small sparkle.'],
 ['q1-scribe','Q1','The scribe','A luminous spine, layered feather barbs and a clean trailing stroke. My pick.'],
 ['q2-sweep','Q2','The flourish','A curved plume and a looping ink stroke. More expressive and flowing.'],
 ['q3-barbed','Q3','The enchanted quill','A serrated feather, brighter facets and a playful zigzag ink flourish.'],
];
for(const [id] of designs){
 const p=decodePng(readFileSync(new URL(id+'-32.png',dir)));
 if(p.w!==32||p.h!==32)throw Error('Master must be 32×32: '+id);
 for(const size of [16,64,192,512]){
  const rgba=new Uint8Array(size*size*4);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
   const i=(Math.floor((y+.5)*32/size)*32+Math.floor((x+.5)*32/size))*4;
   rgba.set(p.rgba.subarray(i,i+4),(y*size+x)*4);
  }
  writeFileSync(new URL(`${id}-${size}.png`,dir),encodePng(size,size,rgba));
 }
 const size=512,rgba=new Uint8Array(size*size*4),unit=11,inset=80;
 for(let y=0;y<size;y++)for(let x=0;x<size;x++){
  const sx=Math.floor((x-inset)/unit),sy=Math.floor((y-inset)/unit),i=(sy*32+sx)*4;
  const inside=sx>=0&&sx<32&&sy>=0&&sy<32;
  const c=inside&&p.rgba[i+3]?Array.from(p.rgba.subarray(i,i+3)):[7,4,13];
  rgba.set([...c,255],(y*size+x)*4);
  if(c.some((v,k)=>v!==[7,4,13][k])&&Math.hypot(x+.5-256,y+.5-256)>204.8)throw Error('Outside mask safe area: '+id);
 }
 writeFileSync(new URL(id+'-maskable-512.png',dir),encodePng(size,size,rgba));
}
const card=([id,label,name,note])=>`<article><small>${label} ${id==='q0-current'?'· 16 PX SOURCE':'· 32 PX MASTER'}</small><div class="hero"><img src="${id}-512.png" alt="${name}"></div><h2>${name}</h2><p>${note}</p><div class="sizes">${[16,32,64].map(n=>`<div><img src="${id}-${n}.png" width="${n}" height="${n}" alt="${n} pixel study"><small>${n} px</small></div>`).join('')}<div><img class="mask" src="${id}-maskable-512.png" width="64" height="64" alt="Circular crop"><small>app crop</small></div></div><div class="tab"><img src="${id}-16.png" width="16" height="16" alt="">Spritewright <span>×</span></div><div class="tab light"><img src="${id}-32.png" width="16" height="16" alt="">Spritewright · Retina <span>×</span></div></article>`;
writeFileSync(new URL('index.html',dir),`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Spritewright · detailed quills</title><style>*{box-sizing:border-box}body{margin:0;background:#0e0b14;color:#eee7fa;font:14px/1.5 system-ui,sans-serif}main{max-width:1500px;margin:auto;padding:40px}header{margin:0 0 28px}header small{letter-spacing:2px;color:#c1a2e9}h1{font-size:36px;letter-spacing:-1px;margin:8px 0}header p{color:#b0a2c4;margin:0}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}article{padding:20px;background:#191321;border:1px solid #3b2c50}small{font:11px monospace;color:#b7a4cc}img{image-rendering:pixelated;object-fit:contain}.hero{display:grid;place-items:center;height:250px}.hero img{width:224px;height:224px}h2{font-size:21px;margin:8px 0}article p{color:#b8abc9;min-height:65px;margin:0 0 16px}.sizes{display:flex;align-items:end;justify-content:space-between;border-top:1px solid #3b2c50;padding-top:16px;margin-bottom:20px}.sizes div{display:flex;flex-direction:column;align-items:center;gap:8px}.mask{border-radius:50%}.tab{display:flex;align-items:center;gap:8px;background:#332640;border-radius:5px 5px 0 0;padding:8px;font-size:11px;margin:6px 0}.tab span{margin-left:auto}.light{background:#ece7f2;color:#3b2c50}footer{margin-top:24px;color:#b8abc9;font-size:12px}@media(max-width:1150px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:600px){main{padding:20px}.grid{grid-template-columns:1fr}h1{font-size:28px}}</style><main><header><small>SPRITEWRIGHT / DETAILED QUILL / ROUND 06</small><h1>More room for a little magic.</h1><p>The existing icon's feather, ink flourish and sparkle, developed on a 32 × 32 grid.</p></header><div class="grid">${designs.map(card).join('')}</div><footer>Edit the 32 px PNG masters in Spritewright. Exporting preserves those edits.<br>16 px studies use nearest-neighbor reduction; the selected design will need a dedicated small favicon pass.</footer></main></html>`);
console.log('Exported four quill studies from editable 32 px PNG masters.');
// A reproducible enlarged strip for the PR, in the same order as the review cards.
const boardW=1184,boardH=320,board=new Uint8Array(boardW*boardH*4);
for(let i=0;i<board.length;i+=4)board.set([14,11,20,255],i);
designs.forEach(([id],n)=>{
 const p=decodePng(readFileSync(new URL(id+'-32.png',dir)));
 for(let y=0;y<256;y++)for(let x=0;x<256;x++){
  const i=(Math.floor(y/8)*32+Math.floor(x/8))*4;
  board.set(p.rgba.subarray(i,i+4),((y+32)*boardW+32+n*288+x)*4);
 }
});
writeFileSync(new URL('comparison.png',dir),encodePng(boardW,boardH,board));
