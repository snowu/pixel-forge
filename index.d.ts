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
  /** false hides the pull request button. */
  pr?: boolean;
  /** URL of the sign-in service (see worker/): enables the "Sign in with GitHub" button. */
  authBase?: string;
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
  setTool(tool: 'pen' | 'erase' | 'fill' | 'line' | 'rect' | 'rectf' | 'pick'): void;
  undo(): void; redo(): void;
  dispose(): void;
}

export interface PullRequestOptions {
  token: string; repo: string; title: string;
  files: { path: string; blob: Blob | Uint8Array }[];
  base?: string; branch?: string; message?: string; prefix?: string;
  body?: string | ((ctx: { baseSha: string; commit: string; headRepo: string }) => string);
  apiBase?: string; fetch?: typeof fetch; onProgress?: (message: string) => void;
}
export interface PullRequestResult { url: string; number: number; branch: string; forked: boolean; commit: string; headRepo: string }

export interface GithubSourceOptions { repo: string; branch?: string; token?: string; apiBase?: string; fetch?: typeof fetch; maxBytes?: number }

export function mount(host: HTMLElement, options?: MountOptions): Editor;
export function createPullRequest(options: PullRequestOptions): Promise<PullRequestResult>;
export function prBody(o: { files: { path: string; w: number; h: number; pixels: number }[]; description?: string; repo?: string; baseSha?: string; commit?: string; headRepo?: string; prefix?: string }): string;

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
export const auth: {
  signIn(authBase: string): Promise<{ token: string; expiresIn: number | null }>;
  user(token: string, o?: { apiBase?: string }): Promise<{ login: string; name: string }>;
  listRepos(token: string, o?: { apiBase?: string }): Promise<string[]>;
  explainError(status: number, message: string, what: string, repo?: string): string;
  tokenUrl: string;
};
export const core: Record<string, unknown>;

declare const Spritewright: { auth: typeof auth; mount: typeof mount; createPullRequest: typeof createPullRequest; prBody: typeof prBody; png: typeof png; sources: typeof sources; core: typeof core };
export default Spritewright;

declare global { interface Window { Spritewright: typeof Spritewright } }
