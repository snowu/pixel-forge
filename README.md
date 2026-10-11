# pixel-forge

A pixel art editor that works **by itself in a browser** or **as a dependency inside a game repository**. No runtime dependencies, no build step.

Draw with pencil, eraser, fill, line, rectangles, colour picker, mirror drawing and "clean lines" (pixel-perfect) mode. Undo/redo, palette tools (recolour a colour everywhere, project palette, snap to palette), flip/rotate/shift/resize, a sprite-sheet animation preview, PNG import and export with nearest-neighbour upscaling. Mouse, touch and keyboard. Saves are **lossless**: PNGs are read and written byte for byte by the editor's own codec, so every channel of every pixel, including semi-transparent ones (for example alpha 250 "emissive" markers), comes back exactly as it went in.

And it can hand art back as a **GitHub pull request**, so an artist never needs git.

## Try it now (nothing to install)

**https://snowu.github.io/pixel-forge/**

Click **Upload PNG** (or **Blank sprite**), draw, and press **Save** or **Export** to download the result. Everything happens in your browser tab: the file is never uploaded anywhere, and the page warns you before you close the tab with unsaved changes. The same page can also open a whole GitHub repository or a folder on your computer (below).

## Three ways to use it

### 1. By itself: open the hosted page, pick a project

No install, nothing in the game repository.

- **A GitHub repository.** Enter `owner/name` (and a token for private repos or to open pull requests). The editor lists the repository's PNGs, you edit them, press **Propose PR**. Or deep-link: `…/index.html?repo=owner/name&branch=main`.
- **A folder on your computer** (Chrome, Edge, Opera). Choose the project folder; the sprites are found, and **Save** writes them back in place.
- Or drag PNG files onto the canvas.

To host the page yourself: copy `index.html` and `pixel-forge.js` to any static host (this repository publishes itself with GitHub Pages, see `.github/workflows/pages.yml`).

### 2. As a dependency of a game repository

```sh
npm i -D pixel-forge            # or: npm i -D github:snowu/pixel-forge   (until it is on the npm registry)
npx pixel-forge init            # writes pixel-forge.config.json (skips docs, screenshots, previews)
npx pixel-forge --open          # editor + save-to-disk server on http://127.0.0.1:5173
```

`pixel-forge init` looks at what a scan finds and writes a starter config; for a project with `art-handoff/`, `public/art/` and `docs/previews/` it picks the first two. Add a script so the artist just runs `npm run art`:

```json
{ "scripts": { "art": "pixel-forge --open" } }
```

Not using npm? Copy `pixel-forge.js`, `index.html`, `bin/` and `src/` into `tools/pixel-forge/` (or add a git submodule) and run `node tools/pixel-forge/bin/pixel-forge.mjs . --open`.

**Save** writes the PNG straight back, atomically (temp file, then rename). New sprites can be created at any path inside the project. In the same session the artist can still use **Propose PR** instead of committing by hand.

Other commands: `pixel-forge scan [dir] -o pixel-art.json` writes a manifest (for the static setup below), `--port`, `--help`.

### 3. As a library inside your own page or tool

```ts
import PixelForge from 'pixel-forge';          // ESM + TypeScript types included; also a plain <script src="pixel-forge.js">
const editor = PixelForge.mount(document.getElementById('editor')!, {
  github: { slug: 'me/my-game', base: 'main' },   // used for pull requests; add connect: 'github' to open it on start
  accent: '#b98cff',
});
```

Works with Vite and other bundlers (checked with a Vite build). Options: `source` (your own), `sprites` + `baseUrl`, `manifestUrl`, `palette`, `save(doc, pngBlob)` to replace saving, `pr: false` to hide the pull-request button. `PixelForge.createPullRequest`, `PixelForge.png.decode/encode`, `PixelForge.sources.*` and `PixelForge.core.*` are exported and tested without a browser. The controller returned by `mount` exposes `current`, `docs`, `open`, `save`, `undo`, `redo`, `dispose`.

## Project config (optional)

`pixel-forge.config.json` in the project root. The local server, the folder mode and the GitHub mode all read it.

```json
{
  "dirs": ["art-handoff", "public"],
  "ignore": ["vendor"],
  "exclude": ["public/screenshots/**"],
  "maxSize": 512,
  "palette": "art/palette.hex",
  "frames": { "public/art/player_walk.png": { "w": 32, "h": 32, "fps": 10 }, "public/art/enemies/*.png": { "w": 32, "h": 32 } },
  "repo": { "slug": "me/my-game", "base": "main", "prefix": "" }
}
```

- `palette` is a `.hex` file (one `rrggbb` per line, the [Lospec](https://lospec.com/palette-list) format): the editor shows it, warns about off-palette colours and can snap an image to it.
- `frames` gives the frame size of sprite sheets for the animation preview (a wide image whose width is a multiple of its height is otherwise treated as a strip of square frames).
- `repo` is detected from `.git/config` and the folder's position in the repository, so you rarely need it. `maxSize` limits sprite dimensions (default 1024); GitHub mode also skips files over 256 KB (`maxBytes`).

Static hosting with a manifest, if you prefer it to the GitHub mode: `pixel-forge scan . -o pixel-art.json`, publish it next to the page, and open `index.html?manifest=pixel-art.json&base=../&repo=owner/name`.

## Signing in with GitHub (no tokens to paste)

Reading **public** repositories needs no sign-in at all. To open **private** repositories and to send pull requests, the editor offers **Sign in with GitHub**: a popup on github.com (your normal login, SSO and 2FA included), then the editor can act on the repositories where the *pixel-forge GitHub App* is installed, with exactly two permissions (Contents and Pull requests, read and write). Tokens last 8 hours and stay in the tab's session storage.

This needs a small auth service because GitHub's token exchange requires a secret and has no CORS: see [`worker/README.md`](worker/README.md) (a ~100-line Cloudflare Worker that stores nothing; about 10 minutes to set up). Until it is set up, the page says so and links to a **pre-filled fine-grained token** (Contents and Pull requests: read and write) as the fallback. Errors from GitHub are explained in plain language ("you are signed in, but the app is not installed on this repository" instead of `403`).

## Pull requests

1. Edit one or more sprites.
2. **Propose PR** lists the sprites changed in this session with the number of pixels changed.
3. Paste a GitHub token, check the repository, title and description, press **Create pull request**.

It uses only the REST API: read the repo and your permissions, fork it if you cannot push (and wait for the fork), read the base branch, upload each PNG as a blob, create a tree and a commit on top of the base branch, create a branch `art/<title>-<id>`, and open the pull request (head `you:branch` for forks). The description holds a table of changed files and, for public repositories, before/after images. GitHub shows PNG changes in the **Files changed** tab with 2-up, swipe and onion-skin views.

**Tokens.** (Signing in as above avoids all of this.) The token goes only to `api.github.com` (or your `apiBase`), is kept in `sessionStorage` (gone when the tab closes) unless "remember" is ticked, and is never written anywhere else.

- Artist with write access: a fine-grained personal access token limited to the game repository with *Contents: read and write* and *Pull requests: read and write*. (Reading a **private** repository in GitHub mode needs *Contents: read* too.)
- Outside contributor: the fork flow needs permission to create a fork and write to it. A classic token with `public_repo` is the simplest option. GitHub's token rules change over time, so check their current docs if a fork fails with 403.
- Public repositories can be opened without a token, but anonymous GitHub API calls are limited to 60 an hour, so add a token for regular use.

**What is and is not verified.** The PR client, GitHub mode and folder mode are covered by unit and browser tests against a **mocked GitHub API** and an **in-memory folder** standing in for the browser's directory picker. They have not been run against the live GitHub service or a real file-picker in this repository's tests, so try each once on a throwaway repository or folder before relying on it. One pull request holds the PNGs changed in the current session; binary files cannot be merged by git, so two people editing the same sprite will conflict like any other binary.

## Safety of the local server

It listens on `127.0.0.1` only, rejects requests whose `Host` header is not `localhost`/`127.0.0.1` on its port (DNS rebinding), only writes `.png` files inside the project (no `..`, no hidden or ignored folders; symlinks are never followed), checks the PNG signature, caps uploads at 8 MB, and requires a per-run secret header for every write. A browser cannot send that header cross-origin without a CORS preflight, which the server never approves, so another website you have open cannot overwrite your art.

## Keys

`B` pencil · `E` eraser · `G` fill · `L` line · `R` rectangle · `F` filled rectangle · `I` picker · `M` mirror X · `+`/`-`/`0` zoom/fit · `#` grid · `Ctrl+Z` / `Ctrl+Y` undo/redo · `Ctrl+S` save · scroll to zoom · space+drag or middle mouse to pan · right click erases · pinch to zoom on touch screens.

## Tests

```sh
node --test test/unit.test.mjs test/worker.test.mjs   # drawing core, PNG codec, scanner, server security, GitHub source, PR client (fake GitHub), init, the auth Worker
node test/pack.mjs                 # npm pack, install into a throwaway project, CLI, ESM entry, TypeScript types, the installed server
npm i -D playwright && npx playwright install chromium
node test/e2e.mjs                  # real server + real browser: drawing, saving to disk, PR flow, hosted GitHub mode, sign-in, folder mode, mobile
```

## Known limitations

- PNG only. Saving writes a plain 8-bit RGBA PNG: indexed or greyscale files become RGBA, 16-bit files are reduced to 8-bit, interlaced files are read through the browser (which may round semi-transparent pixels), and metadata chunks (colour profile, text, resolution) are not kept.
- No layers or selections. For layered work keep the `.aseprite` (or similar) source next to the PNG and use this for quick fixes, palette work and review.
- Undo history is per session and held in memory (100 steps per image).
- Folder mode needs the File System Access API (Chromium browsers). GitHub mode and the local server work in any modern browser; `CompressionStream` is needed for the lossless codec (all current browsers), with a canvas fallback otherwise.
- The "Recolour all" colour dialog depends on the browser's `<input type=color>`.
