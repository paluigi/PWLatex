/**
 * fileSystem.ts
 *
 * Project state & file management built on the native File System Access API.
 *
 * Architecture notes:
 * - `files` is the normalized in-memory cache of the opened folder. It maps a
 *   project-relative path (`"sections/intro.tex"`) to a `ProjectFile` record
 *   that carries both the decoded content (string for text, Uint8Array for
 *   binary) and the live `FileSystemFileHandle` for disk writes.
 * - Keeping everything in this single Map means multi-file compilation is
 *   instant (no re-reading from disk) and future features (AI completion
 *   context builders, reference insert tools) can query the whole project
 *   synchronously.
 */
import { writable, derived, get } from 'svelte/store';

/** File extensions loaded and edited as UTF-8 text. */
const TEXT_EXTENSIONS = new Set([
  'tex', 'ltx', 'latex', 'sty', 'cls', 'bib', 'bst', 'txt', 'md', 'cfg', 'def',
]);

/** File extensions loaded as raw binary bytes (images, embedded PDFs, …). */
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'pdf', 'eps', 'zip',
]);

/** Directories that are never scanned. */
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', '.busytex', 'dist', 'build', 'out']);

/** Refuse to cache individual files above this size (protects the memory budget). */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

/** One entry of the normalized in-memory file cache. */
export interface ProjectFile {
  /** Project-relative path, e.g. `"sections/intro.tex"` (always `/`-separated). */
  path: string;
  /** Base name, e.g. `"intro.tex"`. */
  name: string;
  /** Decoded content: UTF-8 string for text files, raw bytes for binary files. */
  content: string | Uint8Array;
  /** Live handle used to write changes back to disk. */
  handle: FileSystemFileHandle;
  /** True when `content` is a `Uint8Array`. */
  isBinary: boolean;
  /** True when the editor buffer differs from the on-disk content. */
  dirty: boolean;
}

// ---------------------------------------------------------------------------
// Reactive project state
// ---------------------------------------------------------------------------

export const directoryHandle = writable<FileSystemDirectoryHandle | null>(null);

/** Human-readable folder name of the opened project, e.g. `"my-paper"`. */
export const projectName = derived(directoryHandle, (handle) => handle?.name ?? null);

/** The normalized in-memory file cache (path → file record). */
export const files = writable<Map<string, ProjectFile>>(new Map());

/** Project-relative path of the file currently open in the editor. */
export const activeFilePath = writable<string | null>(null);

/** True while a folder is being picked/scanned. */
export const isScanning = writable(false);

/** Last user-facing error message (folder picking, scanning, saving). */
export const fsError = writable<string | null>(null);

/** Flat, sorted list of all cached file paths (convenient for derived stores). */
export const filePaths = derived(files, (map) =>
  [...map.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

export function isTextPath(path: string): boolean {
  return TEXT_EXTENSIONS.has(extensionOf(path));
}

export function isBinaryPath(path: string): boolean {
  return BINARY_EXTENSIONS.has(extensionOf(path));
}

/** Path with `./` prefixes and Windows separators normalized away. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Currently open file record, or null. */
export function activeFile(): ProjectFile | null {
  const path = get(activeFilePath);
  if (!path) return null;
  return get(files).get(path) ?? null;
}

/**
 * Pick a sensible root document: `main.tex` at the project root if present,
 * otherwise the shallowest `.tex` file (preferring conventional root names).
 */
function detectMainTex(map: Map<string, ProjectFile>): string | null {
  const texPaths = [...map.keys()]
    .filter((p) => p.toLowerCase().endsWith('.tex'))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));

  const rootPreferred = ['main.tex', 'root.tex', 'paper.tex', 'article.tex', 'report.tex', 'book.tex'];
  for (const preferred of rootPreferred) {
    const hit = texPaths.find((p) => p.toLowerCase() === preferred);
    if (hit) return hit;
  }
  const rootLevel = texPaths.filter((p) => !p.includes('/'));
  return rootLevel[0] ?? texPaths[0] ?? null;
}

/** Main document used as the compilation entry point. */
export const mainTexPath = derived(files, (map) => detectMainTex(map));

async function ensureReadWritePermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  if (handle.queryPermission && (await handle.queryPermission({ mode: 'readwrite' })) === 'granted') {
    return true;
  }
  if (!handle.requestPermission) return true; // OPFS/testing handles: no permission model.
  return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
}

// ---------------------------------------------------------------------------
// Opening & scanning
// ---------------------------------------------------------------------------

/**
 * Recursively scan `dir` and fill the file cache. `prefix` is the
 * project-relative path of `dir` (`''` for the project root).
 */
async function scanDirectory(dir: FileSystemDirectoryHandle, prefix: string): Promise<void> {
  const batch: Array<[string, ProjectFile]> = [];

  for await (const [name, handle] of dir.entries()) {
    if (name.startsWith('.') && handle.kind === 'directory') continue;

    if (handle.kind === 'directory') {
      if (IGNORED_DIRECTORIES.has(name)) continue;
      await scanDirectory(handle as FileSystemDirectoryHandle, prefix ? `${prefix}/${name}` : name);
      continue;
    }

    const ext = extensionOf(name);
    const isBinary = BINARY_EXTENSIONS.has(ext);
    if (!isBinary && !TEXT_EXTENSIONS.has(ext)) continue; // build artifacts etc.

    const path = prefix ? `${prefix}/${name}` : name;
    const file = await (handle as FileSystemFileHandle).getFile();
    if (file.size > MAX_FILE_BYTES) continue;

    batch.push([
      path,
      {
        path,
        name,
        content: isBinary ? new Uint8Array(await file.arrayBuffer()) : await file.text(),
        handle: handle as FileSystemFileHandle,
        isBinary,
        dirty: false,
      },
    ]);
  }

  if (batch.length > 0) {
    files.update((map) => {
      for (const [path, record] of batch) map.set(path, record);
      return map;
    });
  }
}

/**
 * Open a project folder.
 *
 * With no argument, prompts the user with the native directory picker
 * (`window.showDirectoryPicker`, Chromium desktop browsers). An explicit
 * handle can be passed by callers/tests that already own a directory handle.
 */
export async function openProjectFolder(handle?: FileSystemDirectoryHandle): Promise<boolean> {
  fsError.set(null);

  let dir: FileSystemDirectoryHandle | null = handle ?? null;
  if (!dir) {
    if (typeof window === 'undefined' || typeof window.showDirectoryPicker !== 'function') {
      fsError.set(
        'This browser does not support the File System Access API. Use a desktop Chromium browser (Chrome, Edge, Opera).',
      );
      return false;
    }
    try {
      dir = await window.showDirectoryPicker({ mode: 'readwrite' });
    } catch (err) {
      if ((err as DOMException)?.name !== 'AbortError') {
        fsError.set(`Could not open folder: ${(err as Error).message}`);
      }
      return false; // User cancelled the picker — not an error worth reporting.
    }
  }

  if (!(await ensureReadWritePermission(dir))) {
    fsError.set('Read/write permission for the selected folder was denied.');
    return false;
  }

  isScanning.set(true);
  // Replace, not merge: opening a new project starts from a clean cache.
  files.set(new Map());
  activeFilePath.set(null);
  directoryHandle.set(dir);
  try {
    await scanDirectory(dir, '');
  } catch (err) {
    fsError.set(`Failed to scan folder: ${(err as Error).message}`);
    isScanning.set(false);
    return false;
  }

  const mainPath = detectMainTex(get(files));
  activeFilePath.set(mainPath ?? get(filePaths)[0] ?? null);
  isScanning.set(false);
  return true;
}

/** Close the current project and clear all in-memory state. */
export function closeProject(): void {
  directoryHandle.set(null);
  files.set(new Map());
  activeFilePath.set(null);
  fsError.set(null);
}

// ---------------------------------------------------------------------------
// Editing & saving
// ---------------------------------------------------------------------------

/**
 * Update the in-memory content of a file without touching the disk.
 * Called on every editor change so the cache (and therefore every consumer —
 * compiler, future AI tools) always sees the latest buffer.
 */
export function updateFileContent(path: string, content: string): void {
  files.update((map) => {
    const record = map.get(path);
    if (record && !record.isBinary && record.content !== content) {
      record.content = content;
      record.dirty = true;
      return new Map(map); // new reference so derived stores re-run
    }
    return map;
  });
}

/**
 * Write a file back to disk through its handle.
 * Uses `createWritable()` so the write is atomic-ish (streamed then committed).
 */
export async function saveFile(path: string, content?: string): Promise<void> {
  const record = get(files).get(path);
  if (!record) throw new Error(`saveFile: unknown file "${path}"`);

  const text = content ?? (record.isBinary ? null : (record.content as string));
  if (text === null) throw new Error(`saveFile: "${path}" is binary and cannot be saved as text`);

  const writable = await record.handle.createWritable();
  await writable.write(text);
  await writable.close();

  files.update((map) => {
    const saved = map.get(path);
    if (saved) {
      saved.content = text;
      saved.dirty = false;
      return new Map(map);
    }
    return map;
  });
}

/** Save the file currently open in the editor. Returns its path, or null. */
export async function saveActiveFile(content?: string): Promise<string | null> {
  const path = get(activeFilePath);
  if (!path) return null;
  const record = get(files).get(path);
  if (!record || record.isBinary) return path;
  await saveFile(path, content);
  return path;
}

// ---------------------------------------------------------------------------
// Creating files
// ---------------------------------------------------------------------------

/** Walk (creating as needed) to the directory holding `path`, return its handle. */
async function ensureParentDir(root: FileSystemDirectoryHandle, path: string): Promise<FileSystemDirectoryHandle> {
  const segments = path.split('/').filter(Boolean);
  segments.pop(); // drop the file name
  let dir = root;
  for (const segment of segments) {
    dir = await dir.getDirectoryHandle(segment, { create: true });
  }
  return dir;
}

/**
 * Create a new file on disk (with any missing parent directories), write
 * `content` to it, and register it in the in-memory cache / file tree.
 * Throws if a project folder is not open or the disk write fails.
 */
export async function createFile(path: string, content: string | Uint8Array): Promise<ProjectFile> {
  const root = get(directoryHandle);
  if (!root) throw new Error('createFile: no project folder is open');

  const normalized = normalizePath(path);
  const name = normalized.split('/').pop()!;
  const dir = await ensureParentDir(root, normalized);
  const handle = await dir.getFileHandle(name, { create: true });

  const writable = await handle.createWritable();
  // TS 5.7+: Uint8Array<ArrayBufferLike> isn't assignable to write()'s chunk
  // type; copy into a plain-ArrayBuffer view (same trick as compiler.ts).
  await writable.write(typeof content === 'string' ? content : new Uint8Array(content));
  await writable.close();

  const record: ProjectFile = {
    path: normalized,
    name,
    content,
    handle,
    isBinary: content instanceof Uint8Array,
    dirty: false,
  };
  files.update((map) => {
    map.set(normalized, record);
    return new Map(map); // new reference so derived stores (file tree) re-run
  });
  return record;
}
