# Playground: test art for every feature

Small sprites made so each feature's behaviour shows at a glance. From a clone of spritewright:

```sh
npm run playground      # the editor on this folder, on http://127.0.0.1:5173 (Save writes here: git checkout the folder to reset)
```

Regenerate the art with `node scripts/make-playground.mjs`. The `spritewright.config.json` here turns on what the checks need: the 8-colour `palette.hex`, `tileGrid: 16`, `maxColors: 8`, and the frame size of the sheet.

| Sprite | Try | You should see |
| --- | --- | --- |
| `tiles/dungeon-tiles.png` | **Tiles** (next to Grid), and the **▾** for 8/32 | A stronger line every 16 px, on the seams of the 16×16 tiles. On a tablet: draw with a pencil, then rest your palm or pan with one finger: nothing is drawn. |
| `gradient/sky-window.png` | **J**, drag from the top of the empty window to the bottom | The window (and only it) fills with an ordered dither from the primary colour to the secondary. Right-drag swaps them. |
| `gradient/orb.png` | Select it with the wand (**W**), then **J** across | Only the disc is dithered, not its square box. |
| `selection/islands.png` | **W** on a red disc; then switch the fill mode to *same colour* | Area: one disc. Same colour: all three discs. Shift+click adds, Alt+click takes away. Click inside the green ring: just the hole. **Q**: draw round the star. |
| `lint/mistakes.png` | **P** (Check) | 3 stray (two specks of dust, a hole in the box), doubled corners all along the thick red diagonal (not the clean blue one), 1 near-duplicate colour (the faint patch in the box). |
| `lint/clean.png` | **P** | "no stray pixels, doubled corners or near-duplicate colours": box corners, highlights in a fill, a texture's grain and a thick line are all left alone. |
| `rotate/sword.png` | Image › **Rotate…** 30° and 45° | The outline stays connected; no new colours appear. Select just the blade first to rotate only it. |
| `rotate/diagonals.png` | Image › **Smooth ×2** | 32×32, with the diagonals and the circle smooth instead of 2×2 blocks. |
| `animation/counter-sheet.png` | The **sheet** strip in the Animation panel: click a frame, ◀ ▶, **+ frame**, ✕; the **×n** badge; Play; **Sheet + JSON** | The digit moves with its frame, so reordering is obvious; the sheet grows and shrinks; a ×3 frame holds three ticks; the zip has the PNG and Aseprite-style JSON with durations. |
| `animation/flame_0…3.png` | The family strip, ×n badges, **Sheet + JSON** | The numbered files pack into one 64×16 row. |
| `indexed/potion.png` | Palette › **Indexed**; **Snap** | In the Palette panel, *In this image* shows 10 colours of 8 (over the budget, in red); two colours are a few values off the palette. With Indexed on, a picked colour snaps to the palette; double-click a palette colour to change it everywhere. |
| `notes/face.png` | Notes › **+ note**, click the right eye | A numbered pin on the eye (the click draws nothing), the text in the Notes panel, and a *Notes* section in the next pull request. |
| `layers/slime.png` | The **Layers** panel: hide *shading*, drag its opacity, select *line art* and draw; **Merge ↓**; Save | Three layers (colour, shading at 60 %, line art) and no separate sprite for `slime.layers.png`. Drawing touches only the highlighted layer. Save rewrites both files (`git checkout` the folder to reset); merged down to one layer, Save deletes `slime.layers.png`. |
| `layers/knight.png` | The **Layers** panel: show the hidden *sketch*, hide *line art*, move *shading* up and down, **Copy** a layer, rename one; Ctrl+Z through it all | Four layers as an artist keeps them: a hidden rough sketch, flat colours, shading at 70 %, line art on top. The canvas and the Animation panel show the merged picture; the knight's own PNG only changes when you Save. |
