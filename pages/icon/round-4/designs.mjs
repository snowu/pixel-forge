// Return to round one's broad quill silhouette; keep round three's exact colors.
// J/S = feather and shade; F/H = spine and shaft highlight; X = nib and ink.
import { palettes } from '../round-3/designs.mjs';

export const rows = [
  '................',
  '................',
  '..........JJF...',
  '........JJJFS...',
  '.......JJJFSS...',
  '......JJJFSSS...',
  '.....JJJFSSS....',
  '.....JJFSSS.....',
  '.....JFSSS......',
  '.....FSS........',
  '....FH..........',
  '...FH...........',
  '...X............',
  '.....XX.........',
  '................',
  '................',
];

const notes = [
  'Teal feather, cream spine, coral ink. A warm, colorful craft-tool identity.',
  'Terracotta feather, cream spine, ice-blue ink. Warm material with a cool accent.',
  'Cobalt feather, pale-blue spine, golden ink. Crisp and bright at small sizes.',
  'Leaf-green feather, butter-yellow spine, berry ink. A natural feather palette.',
  'Violet feather, mint spine, tangerine ink. A multicolor link to the original purple.',
  'Slate feather, ivory spine, vermilion ink. Understated feather, vivid drawing accent.',
];

export default palettes.map((p,i) => ({...p,rows,note:notes[i]}));
