// Run after editing a-quill-16.png to rebuild the standalone favicon prototype.
import {readFileSync,writeFileSync} from 'node:fs';
import {decodePng,encodePng} from '../../../test/png.mjs';
const source=decodePng(readFileSync(new URL('../a-quill-16.png',import.meta.url)));
const background=[7,4,13,255], accent=[224,140,255,255];
// The master nib is (3,12). Each contact pose deposits ink at that exact
// translated coordinate; lifting preserves the trail without adding ink.
const poses = [
 {dx:0,dy:0,ink:3,ms:3200}, // Rest above the finished stroke.
 {dx:0,dy:-1,ink:0,ms:180}, // Lift to start a fresh loop.
 {dx:0,dy:1,ink:1,ms:180},  // Touch down at (3,13).
 {dx:1,dy:1,ink:2,ms:180},  // Write to (4,13).
 {dx:2,dy:1,ink:3,ms:180},  // Write to (5,13).
 {dx:2,dy:0,ink:3,ms:180},  // Lift before returning.
 {dx:1,dy:-1,ink:3,ms:180},
];
const frames=poses.map(({dx,dy,ink}) => {
 const pixels=new Uint8Array(16*16*4);
 for(let y=0;y<16;y++) for(let x=0;x<16;x++) {
  const i=(y*16+x)*4;
  pixels.set(background,i);
  if((x===0||x===15)&&(y===0||y===15)) pixels[i+3]=0;
 }
 // Draw the deposited ink first, then the quill above it.
 for(let x=3;x<3+ink;x++) pixels.set(accent,(13*16+x)*4);
 for(let sy=2;sy<=12;sy++) for(let sx=0;sx<16;sx++) {
  const i=(sy*16+sx)*4;
  if(source.rgba[i]===background[0] && source.rgba[i+1]===background[1] && source.rgba[i+2]===background[2]) continue;
  const x=sx+dx,y=sy+dy;
  if(x>=0&&x<16&&y>=0&&y<16) pixels.set(source.rgba.subarray(i,i+4),(y*16+x)*4);
 }
 return pixels;
});
const urls=frames.map((rgba,i)=>{
 const png=encodePng(16,16,rgba);
 writeFileSync(new URL(`quill_${i}.png`,import.meta.url),png);
 return 'data:image/png;base64,'+Buffer.from(png).toString('base64');
});
const script=`(() => {
  const frames = ${JSON.stringify(urls)};
  const durations = ${JSON.stringify(poses.map(p=>p.ms))};
  const icon = document.querySelector('link[rel="icon"]');
  const preview = document.getElementById('favicon-preview');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let timer, frame = 0;
  function draw() {
    icon.href = frames[frame];
    if (preview) preview.src = frames[frame];
  }
  function reset() {
    clearTimeout(timer);
    frame = 0;
    draw();
    if (!document.hidden && !motion.matches) timer = setTimeout(tick, durations[0]);
  }
  function tick() {
    frame = (frame + 1) % frames.length;
    draw();
    timer = setTimeout(tick, durations[frame]);
  }
  document.addEventListener('visibilitychange', reset);
  motion.addEventListener('change', reset);
  reset();
})();`;
const block=`<!-- animated-quill:start -->\n<script>\n${script}\n</script>\n<!-- animated-quill:end -->`;
const main=new URL('../../../index.html',import.meta.url);
let html=readFileSync(main,'utf8').replace(/<!-- animated-quill:start -->[\s\S]*?<!-- animated-quill:end -->\n?/,'');
html=html.replace(/(<link rel="icon"[^>]*href=")[^"]*(")/,`$1${urls[0]}$2`);
writeFileSync(main,html.replace('</body>',block+'\n</body>'));
writeFileSync(new URL('index.html',import.meta.url),`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Spritewright · animated quill prototype</title><link rel="icon" type="image/png" href="${urls[0]}"><style>body{margin:48px;background:#07040d;color:#e6dcf7;font:16px/1.6 system-ui}img{image-rendering:pixelated;width:192px;height:192px}h1{font-size:28px}p{max-width:540px}a{color:#e08cff}</style><h1>Animated pixel quill</h1><img id="favicon-preview" src="${urls[0]}" alt="Animated pixel quill"><p>Watch the browser tab: the A-quill touches down, writes a short ink stroke, and lifts every few seconds. The enlarged preview shows the same frames.</p><p>Animation pauses in background tabs and uses the original static quill when reduced motion is enabled.</p>${block}</html>`);
console.log(`Generated ${frames.length} editable PNG frames and wired the standalone favicon.`);
