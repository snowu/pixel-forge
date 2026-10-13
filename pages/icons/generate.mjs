// Edit icon-512.png in Spritewright, then regenerate all delivery formats.
// The source PNG is never overwritten by this exporter.
import {readFileSync,writeFileSync} from 'node:fs';
import {decodePng,encodePng} from '../../test/png.mjs';
const dir=new URL('./',import.meta.url),source=decodePng(readFileSync(new URL('icon-512.png',dir)));
if(source.w!==512||source.h!==512)throw Error('icon-512.png must be 512 × 512');
// Area averaging preserves fine feather details when reducing the master.
function resize(size){
 const rgba=new Uint8Array(size*size*4),scale=512/size;
 for(let y=0;y<size;y++)for(let x=0;x<size;x++){
  const x0=x*scale,x1=(x+1)*scale,y0=y*scale,y1=(y+1)*scale,sum=[0,0,0],area=scale*scale;let alpha=0;
  for(let sy=Math.floor(y0);sy<Math.ceil(y1);sy++)for(let sx=Math.floor(x0);sx<Math.ceil(x1);sx++){
   const weight=(Math.min(x1,sx+1)-Math.max(x0,sx))*(Math.min(y1,sy+1)-Math.max(y0,sy));
   const i=(sy*512+sx)*4,a=source.rgba[i+3]/255;alpha+=a*weight;
   for(let c=0;c<3;c++)sum[c]+=source.rgba[i+c]*a*weight;
  }
  const i=(y*size+x)*4;for(let c=0;c<3;c++)rgba[i+c]=alpha?Math.round(sum[c]/alpha):0;rgba[i+3]=Math.round(alpha/area*255);
 }
 return rgba;
}
const favicon=encodePng(192,192,resize(192));
writeFileSync(new URL('icon-192.png',dir),favicon);
writeFileSync(new URL('apple-touch-icon.png',dir),encodePng(180,180,resize(180)));
const inset=64,small=resize(384),mask=new Uint8Array(512*512*4);
for(let y=0;y<512;y++)for(let x=0;x<512;x++){
 const i=(y*512+x)*4;mask.set([8,5,16,255],i);
 if(x>=inset&&x<512-inset&&y>=inset&&y<512-inset){
  const j=((y-inset)*384+x-inset)*4,a=small[j+3]/255;
  for(let c=0;c<3;c++)mask[i+c]=Math.round(small[j+c]*a+mask[i+c]*(1-a));
 }
}
writeFileSync(new URL('icon-maskable-512.png',dir),encodePng(512,512,mask));
const entry=new URL('../../index.html',dir);
const html=readFileSync(entry,'utf8');
if(!/<link rel="icon"[^>]+>/.test(html))throw Error('Favicon link missing');
writeFileSync(entry,html.replace(/<link rel="icon"[^>]+>/,`<link rel="icon" type="image/png" sizes="192x192" href="data:image/png;base64,${Buffer.from(favicon).toString('base64')}">`));
console.log('Exported 192 px favicon, Apple touch icon and padded maskable icon from the unchanged 512 px master.');
