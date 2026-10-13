// Keep C2's face, violet body and feet. Refine the gesture a few pixels at a time.
import previous from '../round-2/designs.mjs';
const keeper = previous.find(d => d.id === 'c2-maker');
function revise(edits) {
 const rows=keeper.rows.map(row=>[...row]);
 for(const [y,row] of Object.entries(edits)) rows[Number(y)]=[...row];
 return rows.map(row=>row.join(''));
}
export default [
 {...keeper,id:'c2-reference',label:'C2',name:'Our original keeper',theme:'REFERENCE',description:'The familiar little blob, curious eyes and floating pink pixel.',tradeoff:'The original reaching hand is only one pixel wide.'},
 {id:'c2a-palm',label:'C2a',name:'A clearer little hand',theme:'CLOSE REFINEMENT',description:'Same face and body. An open palm directly below the pixel makes the gesture easier to see.',tradeoff:'My pick: keeps his personality with only four changed pixels.',rows:revise({
  7:'...PP..P..D.PP..',
  8:'...PPPPPPPD..D..',
  9:'..PPPPPPPPDPDD..',
  10:'...PPPPPPPDD....',
 })},
 {id:'c2b-close',label:'C2b',name:'A pixel of his own',theme:'COMPACT GESTURE',description:'The pink pixel sits closer to his cheek; a shorter arm and tiny palm keep everything together.',tradeoff:'More compact at small sizes; the floating pixel has less breathing room.',rows:revise({
  4:'....LPPPP.......',
  5:'...LPPPPPD.MM...',
  6:'...PP..P..DMM...',
  7:'...PP..P..D.....',
  8:'...PPPPPPPDPP...',
  9:'..PPPPPPPPDDD...',
  10:'...PPPPPPPDD....',
 })},
];
