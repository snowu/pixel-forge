/** A sprite in the project list. w/h are unknown until the file is read for some sources (GitHub). */
export interface SpriteEntry { path: string; w?: number; h?: number; bytes?: number; frames?: { w: number; h: number; fps?: number }; local?: boolean }

export interface RepoInfo { slug?: string | null; base?: string | null; prefix?: string; canPush?: boolean }

/** Where sprites come from and how they are read and written. */
export interface Source {
  kind: string;
  note?: string;
  sprites: SpriteEntry[];
  thumbs: boolean;
  repo?: RepoInfo | null;
  palette?: string[] | null;
  /** The project's background colour from its config, if any. */
  background?: string | null;
  read(path: string): Promise<Uint8Array>;
  write?(path: string, bytes: Uint8Array): Promise<void>;
}

export interface MountOptions {
  /** Provide your own source (see `sources`). */
  source?: Source;
  /** A fixed list of sprites, fetched relative to baseUrl. */
  sprites?: SpriteEntry[];
  paletteList?: string[];
  /** URL of a manifest made by `spritewright scan`. */
  manifestUrl?: string;
  /** Where sprite paths resolve to (static mode). */
  baseUrl?: string;
  /** Project palette ('#rrggbb'). */
  palette?: string[];
  /** Repository used for pull requests; with connect: 'github' it is also opened on start. */
  github?: { slug?: string; base?: string; prefix?: string };
  connect?: 'github' | false;
  /** Start with an empty sprite (and no project dialog): handy for embedding a scratch pad. */
  blank?: { w?: number; h?: number; name?: string };
  /** Theme colour. */
  accent?: string;
  /** Replace the default Save behaviour. */
  save?: (doc: Doc, png: Blob) => Promise<void> | void;
  /** Edits are kept in this browser (IndexedDB) as you draw and come back after a reload. false turns that off;
      or pass your own store with the same shape as core.browserDrafts(). */
  drafts?: false | { list(project: string): Promise<unknown[]>; put(project: string, rec: unknown): Promise<unknown>; remove(project: string, path: string): Promise<unknown>; clear(project: string): Promise<unknown> };
  /** The key edits are kept under in this browser (default: derived from the project: repo@branch, folder name, page URL). */
  draftsKey?: string;
  /** false hides the pull request button. */
  pr?: boolean;
  /** The Feedback button. Signed in with GitHub (authBase, with feedback set up: see worker/README.md) it sends the issue as the reporter;
      signed out it opens a prefilled GitHub issue (screenshot on the clipboard). Default repository "snowu/spritewright"; another "owner/name"
      sends the prefilled link there; false hides the button. */
  feedback?: boolean | string | { repo: string };
  /** URL of the sign-in service (see worker/): enables the "Sign in with GitHub" button. */
  authBase?: string;
  /** Slug of the GitHub App used for sign-in; when set, the repository list links to installing it on more repositories. */
  githubApp?: string;
  /** Page that "Copy link to this project" points at (…?repo=owner/name). Default: this page, or the hosted editor when this page is local. */
  shareBase?: string;
  /** The game's background colour (#rrggbb): offered as "Project background" behind transparent pixels. Overrides the project config's "background". */
  background?: string;
  /** Where to show "Signed in as … / Sign out" (an element or a selector in the host page, e.g. its header). Default: the sidebar. */
  accountEl?: Element | string;
  /** Alternative GitHub API base (GitHub Enterprise, tests). */
  apiBase?: string;
}

export interface Doc {
  path: string; w: number; h: number;
  /** Straight-alpha pixels, 0xAABBGGRR. */
  px: Uint32Array;
  readonly unsaved: boolean; readonly changed: boolean;
  changedPixels(): number;
}

export interface Editor {
  readonly docs: Map<string, Doc>;
  readonly current: Doc | undefined;
  open(path: string): Promise<void>;
  save(): Promise<void>;
  setColor(abgr: number): void;
  /** The colour right click paints with; 0 (clear) means right click erases. */
  setColor2(abgr: number): void;
  setTool(tool: 'pen' | 'erase' | 'fill' | 'line' | 'rect' | 'rectf' | 'ellipse' | 'ellipsef' | 'pick' | 'select' | 'shade'): void;
  /** Select the whole image (the select tool becomes active). */
  selectAll(): void;
  undo(): void; redo(): void;
  dispose(): void;
}

export interface PullRequestOptions {
  token: string; repo: string; title: string;
  files: { path: string; blob: Blob | Uint8Array }[];
  /** Upscaled before/after PNGs for the description, one entry per file (same order). Committed on no branch, kept by refs/spritewright/previews/<branch>. */
  previews?: { before?: Blob | Uint8Array | null; after?: Blob | Uint8Array | null }[];
  base?: string; branch?: string; message?: string; prefix?: string;
  body?: string | ((ctx: { baseSha: string; commit: string; headRepo: string; previewSha: string | null }) => string);
  apiBase?: string; fetch?: typeof fetch; onProgress?: (message: string) => void;
}
export interface PullRequestResult { url: string; number: number; branch: string; forked: boolean; commit: string; headRepo: string; previewSha: string | null }

export interface GithubSourceOptions { repo: string; branch?: string; token?: string; apiBase?: string; fetch?: typeof fetch; maxBytes?: number }

export function mount(host: HTMLElement, options?: MountOptions): Editor;
export function createPullRequest(options: PullRequestOptions): Promise<PullRequestResult>;
/** Helpers behind the Feedback button: the prefilled GitHub "new issue" link (template .github/ISSUE_TEMPLATE/feedback.yml, kept under GitHub's URL length limit) and its details as a markdown table. */
export const feedback: {
  url(o?: { what?: string; details?: string; kind?: 'bug' | 'idea' | 'other'; repo?: string }): string;
  title(text: string, kind?: 'bug' | 'idea' | 'other', words?: number, maxChars?: number): string;
  details(rows: [string, string][]): string;
  repo: string;
};
export function prBody(o: { files: { path: string; w: number; h: number; pixels: number; scale?: number; baseW?: number; isNew?: boolean }[]; description?: string; repo?: string; baseSha?: string; commit?: string; headRepo?: string; prefix?: string; previewSha?: string | null }): string;

export const png: {
  /** Lossless PNG decode (all 8-bit types, 1/2/4-bit indexed and grey, 16-bit reduced to 8). Throws for interlaced files. */
  decode(bytes: Uint8Array): Promise<{ w: number; h: number; px: Uint32Array }>;
  /** Lossless 8-bit RGBA encode. scale > 1 repeats each pixel. */
  encode(w: number, h: number, px: Uint32Array, scale?: number): Promise<Uint8Array>;
};
export const sources: {
  githubSource(o: GithubSourceOptions): Promise<Source>;
  folderSource(dir: FileSystemDirectoryHandle, o?: { maxSize?: number }): Promise<Source>;
  staticSource(manifest: { sprites: SpriteEntry[]; palette?: string[] | null; repo?: RepoInfo | null }, baseUrl?: string): Source;
  serverSource(manifest: { sprites: SpriteEntry[]; palette?: string[] | null; repo?: RepoInfo | null }, token?: string): Source;
  applyConfig<T extends { path: string }>(items: T[], config?: { dirs?: string[]; ignore?: string[]; exclude?: string[]; frames?: Record<string, { w: number; h: number; fps?: number }> }): T[];
};
export interface Grant { token: string; expiresIn: number | null; refreshToken: string | null; refreshExpiresIn: number | null }
export const auth: {
  signIn(authBase: string): Promise<Grant>;
  /** Renew an expiring GitHub App user token through the auth service. */
  refresh(authBase: string, refreshToken: string): Promise<Grant>;
  user(token: string, o?: { apiBase?: string }): Promise<{ login: string; name: string }>;
  listRepos(token: string, o?: { apiBase?: string; details?: false }): Promise<string[]>;
  listRepos(token: string, o: { apiBase?: string; details: true }): Promise<{ name: string; private: boolean; push: boolean; branch: string | null }[]>;
  explainError(status: number, message: string, what: string, repo?: string): string;
  tokenUrl: string;
};
export const core: Record<string, unknown>;

declare const Spritewright: { auth: typeof auth; mount: typeof mount; createPullRequest: typeof createPullRequest; prBody: typeof prBody; feedback: typeof feedback; png: typeof png; sources: typeof sources; core: typeof core };
export default Spritewright;

declare global { interface Window { Spritewright: typeof Spritewright } }
