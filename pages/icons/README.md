# Spritewright quill

![Detailed quill master](icon-512.png)

**Edit `pages/icons/icon-512.png` in Spritewright.** It is the single 512 × 512 master for the app: a layered violet feather, ivory spine, gold nib, connected pink ink flourish and two glints.

Run `node pages/icons/generate.mjs` after saving edits. The exporter preserves the master and derives the 192 × 192 favicon, 180 × 180 Apple touch icon and padded 512 × 512 maskable icon. It also updates the inline favicon in the root `index.html`, keeping the standalone editor self-contained. Smaller outputs use area averaging to preserve fine detail.

Open this directory's `index.html` for a large preview, browser-sized displays and a circular app crop. The browser still displays its tab icon at a small size; supplying a 192 px PNG does not enlarge the tab slot.

Previous designs and size studies have been removed. Required install formats are exports of this one artwork.
