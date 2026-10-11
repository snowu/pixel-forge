# pixel-forge

A small pixel art editor you can drop into any game project. No dependencies, no build step.

- **Finds the art for you.** `pixel-forge` scans the project for PNG sprites and tile sheets and lists them.
- **Edits and saves in place.** Pencil, eraser, fill, line, rectangles, colour picker, mirror drawing, "clean lines" (pixel-perfect) mode, undo/redo, palette tools, flip/rotate/shift/resize, a sprite-sheet animation preview, PNG import and export (with nearest-neighbour upscaling). Works with mouse, touch and keyboard.
- **Lets an artist propose changes without git.** The editor can create a branch, commit the changed PNGs and open a pull request through the GitHub API (forking first if the artist has no write access). GitHub already shows PNG changes in a pull request with 2-up, swipe and onion-skin views, so review is visual.

```
pixel-forge/
  pixel-forge.js        the editor: ONE file, drop it anywhere (window.PixelForge)
  index.html            a standalone page that mounts it
  bin/pixel-forge.mjs   CLI: `serve` (editor + save-to-disk server) and `scan` (JSON manifest)
  src/scan.mjs          the project scanner
  src/serve.mjs         the local server (127.0.0.1 only)
  test/                 unit tests (node:test) and browser tests (Playwright)
```

## Use it on a project (local, saves into the folder)

```sh
cd ~/personal/pixel-forge          # once
node bin/pixel-forge.mjs ~/my-game --open
# or, after `npm link`:   pixel-forge ~/my-game --open
```

It prints a URL (default `http://127.0.0.1:5173/`). Every PNG up to 1024×1024 under the folder is listed (`node_modules`, `.git`, `.godot`, `.import`, `zig-out`, `build` and similar are skipped). **Save** (Ctrl+S) writes the PNG straight back, atomically (temp file, then rename). New sprites can be created at any path inside the project.

To keep it with the game, copy `pixel-forge.js`, `index.html`, `bin/` and `src/` into a `tools/pixel-forge/` folder (or add this repo as a git submodule) and run `node tools/pixel-forge/bin/pixel-forge.mjs .`.

### Project config (optional)

`pixel-forge.config.json` in the project root:

```json
{
  "dirs": ["assets", "art"],
  "ignore": ["vendor"],
  "exclude": ["assets/screenshots/**"],
  "maxSize": 512,
  "palette": "art/palette.hex",
  "frames": { "assets/player/walk.png": { "w": 16, "h": 16, "fps": 10 }, "assets/enemies/*.png": { "w": 32, "h": 32 } },
  "repo": { "slug": "me/my-game", "base": "main", "prefix": "" }
}
```

- `palette` is a `.hex` file (one `rrggbb` per line, the [Lospec](https://lospec.com/palette-list) format). The editor then shows the project palette, warns about off-palette colours and can snap an image to it.
- `frames` gives the frame size for sprite sheets so the animation preview works immediately (otherwise a wide image whose width is a multiple of its height is treated as a strip of square frames).
- `repo` is detected from `.git/config` (the `origin` remote) and the folder's position inside the repository, so you normally do not need it.

## Static hosting (for artists, no server)

```sh
pixel-forge scan ~/my-game -o ~/my-game/pixel-art.json
```

Publish the editor page next to the manifest (for example on GitHub Pages) and open `index.html?manifest=pixel-art.json&base=../`. `base` is where the sprite paths in the manifest are relative to. In this mode **Save** downloads the PNG (or, in Chromium, writes into a folder you pick), and **Propose PR** is the way to get the art back into the repository.

## Opening a pull request

1. Edit one or more sprites.
2. **Propose PR** lists exactly the sprites changed in this session, with the number of pixels changed.
3. Paste a GitHub token, check the repository, title and description, press **Create pull request**.

What it does, using only the REST API: read the repo and your permissions, (fork it if you cannot push, and wait for the fork), read the base branch, upload each PNG as a blob, create a tree and a commit on top of the base branch, create a branch `art/<title>-<id>`, and open the pull request (head `you:branch` for forks). The description includes a table of changed files and, for public repos, before/after images.

**Tokens.** The token is sent only to `api.github.com` (or `apiBase` if you configure one), kept in `sessionStorage` (gone when the tab closes) unless "remember" is ticked, and never written anywhere else.

- Artist with write access: a fine-grained personal access token limited to the game repository with *Contents: read and write* and *Pull requests: read and write*.
- Outside contributor: the fork flow needs permission to create a fork and write to it. A classic token with `public_repo` is the simplest option. (GitHub's token rules change over time, so check their current docs if a fork fails with 403.)

**Limits to know about.** The PR client is covered by unit and browser tests against a mocked GitHub API; it has not been run against the live service in this repository's tests, so try it once on a throwaway repo before relying on it. One pull request holds the PNGs changed in the current session; binary files cannot be merged by git, so two people editing the same sprite will conflict like any other binary.

## Library use

```html
<div id="editor" style="height: 100vh"></div>
<script src="pixel-forge.js"></script>
<script>
  const editor = PixelForge.mount(document.getElementById('editor'), {
    sprites: [{ path: 'art/hero.png', w: 16, h: 16 }],   // or manifestUrl: 'pixel-art.json'
    baseUrl: '/',                                         // where the paths resolve (static mode)
    palette: ['#1a1c2c', '#5d275d', '#b13e53'],           // optional project palette
    github: { slug: 'me/my-game', base: 'main', prefix: 'game/' },
    accent: '#b98cff',                                    // theme colour
    save: async (doc, pngBlob) => { /* your own save, e.g. upload to your backend */ },
    pr: true,                                             // false hides the pull request button
  });
  editor.current;  // the open Doc: { path, w, h, px (Uint32Array 0xAABBGGRR) }
</script>
```

`PixelForge.createPullRequest(options)` and `PixelForge.core` (colour, line, fill, flip/rotate helpers) are exported too and are tested without a browser.

## Safety of the local server

It listens on `127.0.0.1` only, rejects requests whose `Host` header is not `localhost`/`127.0.0.1` on its port (DNS rebinding), only writes `.png` files inside the project (no `..`, no hidden or ignored folders, no symlink escapes: links are never followed), checks the PNG signature, caps uploads at 8 MB, and requires a per-run secret header for every write. The browser cannot send that header cross-origin without a CORS preflight, which the server never approves, so another website you have open cannot overwrite your art.

## Keys

`B` pencil · `E` eraser · `G` fill · `L` line · `R` rectangle · `F` filled rectangle · `I` picker · `M` mirror X · `+`/`-`/`0` zoom/fit · `#` grid · `Ctrl+Z` / `Ctrl+Y` undo/redo · `Ctrl+S` save · scroll to zoom · space+drag or middle mouse to pan · right click erases · pinch to zoom on touch screens.

## Tests

```sh
node --test test/unit.test.mjs          # drawing core, scanner, server security, PR client (fake GitHub)
npm i -D playwright && npx playwright install chromium
node test/e2e.mjs                        # the real server and a real browser: drawing, saving to disk, PR flow (mocked API), mobile
```

## Known limitations

- PNG is the only format. Colours are stored with straight alpha but browsers decode through a canvas, so semi-transparent pixels can lose a little RGB precision. Pixel art with fully opaque or fully transparent pixels is unaffected.
- No layers, selections or onion-skin editing. For layered work keep the `.aseprite` source next to the PNG and use this for quick fixes, palette work and reviews.
- Undo history is per session and held in memory (100 steps per image).
- The "Recolour all" colour dialog depends on the browser's `<input type=color>`.
