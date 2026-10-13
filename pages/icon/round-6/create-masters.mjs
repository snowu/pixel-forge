// Pixel construction recipes. Existing editable PNG masters are never overwritten.
import {existsSync,writeFileSync,readFileSync} from 'node:fs';
import {encodePng,decodePng} from '../../../test/png.mjs';
const colors={'.':'07040d',p:'b98cff',l:'d9c2ff',h:'f4eefc',s:'8f68d8',d:'5e4399',m:'e08cff',i:'6a5890'};
const output=new URL('./',import.meta.url);
function make(id,draw){
 const file=new URL(id+'-32.png',output);if(existsSync(file))return;
 const rows=Array.from({length:32},()=>Array(32).fill('.'));
 const dot=(x,y,c)=>{if(x>=0&&y>=0&&x<32&&y<32)rows[y][x]=c;};
 const line=(x0,y0,x1,y1,c)=>{let dx=Math.abs(x1-x0),sx=x0<x1?1:-1,dy=-Math.abs(y1-y0),sy=y0<y1?1:-1,e=dx+dy;for(;;){dot(x0,y0,c);if(x0===x1&&y0===y1)break;const e2=e*2;if(e2>=dy){e+=dy;x0+=sx;}if(e2<=dx){e+=dx;y0+=sy;}}};
 const path=(points,c)=>points.slice(1).forEach((p,i)=>line(...points[i],...p,c));
 const poly=(pts,c)=>{for(let y=0;y<32;y++)for(let x=0;x<32;x++){let inside=false;for(let i=0,j=pts.length-1;i<pts.length;j=i++){const a=pts[i],b=pts[j];if((a[1]>y+.5)!==(b[1]>y+.5)&&x+.5<(b[0]-a[0])*(y+.5-a[1])/(b[1]-a[1])+a[0])inside=!inside;}if(inside)dot(x,y,c);}};
 const star=(x,y)=>{line(x-2,y,x+2,y,'m');line(x,y-2,x,y+2,'m');dot(x,y,'h');};
 draw({dot,line,path,poly,star});
 const rgba=new Uint8Array(32*32*4);
 rows.forEach((row,y)=>row.forEach((c,x)=>rgba.set([...colors[c].match(/../g).map(n=>parseInt(n,16)),((x<2||x>=30)&&(y<2||y>=30))?0:255],(y*32+x)*4)));
 writeFileSync(file,encodePng(32,32,rgba));
}
make('q1-scribe',({poly,path,line,dot,star})=>{
 poly([[27,3],[28,7],[26,11],[27,11],[23,16],[21,17],[22,18],[17,22],[12,23],[11,21],[10,19],[12,15],[10,15],[15,10],[19,7],[22,5]],'d');
 poly([[27,3],[25,10],[21,15],[17,19],[11,22],[11,18],[13,14],[12,14],[17,9],[23,5]],'p');
 poly([[26,4],[23,10],[18,15],[12,20],[13,16],[17,12],[16,12],[21,7]],'l');
 poly([[26,6],[25,11],[21,16],[18,19],[15,21],[19,15],[23,10]],'s');
 path([[26,4],[24,8],[20,13],[16,18],[12,22],[8,25]],'h');
 path([[24,9],[21,10],[18,10]],'p');path([[20,14],[17,14],[15,13]],'p');
 path([[23,12],[25,11]],'d');path([[19,17],[22,16]],'d');
 line(11,23,8,26,'l');line(8,25,6,27,'m');
 path([[6,27],[8,28],[12,28],[15,26],[18,26],[20,27],[23,27]],'m');dot(24,26,'l');
 star(26,21);dot(22,23,'i');
});
make('q2-sweep',({poly,path,line,dot,star})=>{
 poly([[27,3],[28,6],[27,10],[25,14],[22,17],[20,18],[20,20],[15,23],[10,23],[10,20],[12,16],[11,16],[15,11],[19,7],[23,5]],'d');
 poly([[27,3],[26,8],[23,13],[19,18],[14,22],[10,23],[11,19],[14,15],[13,15],[18,9],[23,5]],'p');
 poly([[26,4],[23,9],[18,14],[13,20],[11,21],[13,17],[16,13],[15,13],[21,7]],'l');
 poly([[26,8],[24,13],[20,17],[15,22],[18,17],[23,11]],'s');
 path([[26,4],[24,8],[21,12],[18,16],[14,20],[10,23],[7,25]],'h');
 path([[21,12],[18,12],[16,11]],'p');path([[17,17],[14,17]],'p');
 path([[24,13],[22,13]],'d');line(20,18,18,19,'d');
 line(9,24,7,26,'l');dot(6,27,'m');
 path([[6,27],[9,29],[14,29],[18,27],[20,25],[23,25],[24,26],[23,27],[21,27]],'m');
 star(26,20);dot(23,21,'i');
});
make('q3-barbed',({poly,path,line,dot,star})=>{
 poly([[26,3],[28,6],[27,10],[25,12],[26,13],[22,17],[23,17],[19,21],[12,23],[10,22],[10,19],[13,15],[11,15],[15,11],[14,11],[20,6]],'d');
 poly([[26,3],[26,8],[22,13],[18,18],[12,22],[10,22],[11,19],[15,14],[12,15],[17,10],[16,10],[21,6]],'p');
 poly([[26,3],[24,8],[20,12],[16,16],[11,21],[13,17],[17,12],[15,12],[21,6]],'l');
 poly([[26,8],[24,13],[20,17],[17,20],[13,22],[18,16],[22,12]],'s');
 path([[26,4],[23,9],[19,14],[15,19],[11,23],[8,26]],'h');
 path([[22,9],[20,9],[19,8]],'p');path([[19,14],[17,14],[16,13]],'p');
 line(24,13,22,14,'d');line(20,18,18,19,'d');
 line(10,24,7,27,'l');dot(6,28,'m');
 path([[6,28],[10,28],[13,26],[16,26],[18,28],[21,28],[23,26]],'m');
 star(26,21);dot(22,23,'l');
});
const base=decodePng(readFileSync(new URL('../../icons/icon-512.png',import.meta.url)));
const ref=new Uint8Array(32*32*4);for(let y=0;y<32;y++)for(let x=0;x<32;x++){const i=((y*16+8)*512+x*16+8)*4;ref.set(base.rgba.subarray(i,i+4),(y*32+x)*4);}
const file=new URL('q0-current-32.png',output);if(!existsSync(file))writeFileSync(file,encodePng(32,32,ref));
