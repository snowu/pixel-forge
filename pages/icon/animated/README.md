# Animated A-quill prototype

The standalone editor now cycles seven embedded PNG favicon frames: rest, writing, sparkle, rest. It pauses while the document is hidden and keeps the original A-quill still when reduced motion is enabled.

Open `pages/icon/animated/index.html` directly in a browser for an enlarged preview and the animated browser tab. Open the repository's `index.html` to try it in the editor. This PR branch must be checked out locally; the live Pages site changes after merge.

Edit `pages/icon/a-quill-16.png`, then run `node pages/icon/animated/generate.mjs` to regenerate the frames, preview and embedded favicon. The generated `quill_0.png` through `quill_6.png` are also editable in Spritewright.

Browser favicon refresh behavior varies; the embedded original frame remains the static fallback.
