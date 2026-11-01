/**
 * zipService.ts
 *
 * Project portability, entirely in the browser via JSZip — no backend.
 *
 * - `exportProjectZip()` packs every file from the normalized in-memory
 *   cache (text sources and binary assets alike, relative paths preserved)
 *   into `${projectName}.zip` and downloads it.
 * - `importProjectZip(file)` unpacks a chosen .zip into an empty local
 *   folder picked with `showDirectoryPicker()`, writes every entry to disk
 *   through the File System Access API, then loads the folder into the
 *   editor and compiles its main document.
 */

import JSZip from 'jszip';
import { get } from 'svelte/store';
import { files, projectName, isTextPath, normalizePath, openProjectFolder } from './fileSystem';
import { compileProject } from './compiler';

/** Entries that are archive/OS junk rather than project content. */
function isJunkEntry(path: string): boolean {
  const normalized = normalizePath(path);
  return (
    normalized.startsWith('__MACOSX/') ||
    normalized.split('/').pop() === '.DS_Store' ||
    normalized === ''
  );
}

/** Skip entries that could escape the chosen folder ("../evil", "/abs"). */
function isUnsafeEntry(path: string): boolean {
  const segments = normalizePath(path).split('/');
  return segments.some((segment) => segment === '..' || segment === '' || segment === '.');
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Zip the whole project cache and trigger a browser download. */
export async function exportProjectZip(): Promise<void> {
  const map = get(files);
  if (map.size === 0) throw new Error('Nothing to export — open a project first.');

  const zip = new JSZip();
  for (const record of map.values()) {
    // `content` is a string for text files, Uint8Array for binary assets —
    // JSZip accepts both and preserves the project-relative path.
    zip.file(record.path, record.content);
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${get(projectName) ?? 'project'}.zip`;
  anchor.click();
  // Give the download a moment to start before releasing the blob URL.
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * Unpack `zipFile` into a fresh local folder and load it as the active
 * project. Resolves to false when the user cancels the folder picker;
 * rejects with a user-facing message on real failures.
 */
export async function importProjectZip(zipFile: File): Promise<boolean> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(zipFile);
  } catch {
    throw new Error('Could not read the archive — is it a valid .zip file?');
  }

  const entries = Object.values(zip.files).filter((entry) => !entry.dir && !isJunkEntry(entry.name));
  const safeEntries = entries.filter((entry) => !isUnsafeEntry(entry.name));
  if (safeEntries.length === 0) throw new Error('The archive contains no project files.');

  if (typeof window.showDirectoryPicker !== 'function') {
    throw new Error(
      'This browser does not support the File System Access API. Use a desktop Chromium browser (Chrome, Edge, Opera).',
    );
  }

  let root: FileSystemDirectoryHandle;
  try {
    root = await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (err) {
    if ((err as DOMException)?.name !== 'AbortError') {
      throw new Error(`Could not choose a folder: ${(err as Error).message}`);
    }
    return false; // user cancelled the picker — not an error
  }

  // Require an empty destination so an import never clobbers existing files.
  for await (const [name] of root.entries()) {
    throw new Error(`"${root.name}" is not empty (found "${name}"). Pick or create an empty folder.`);
  }

  for (const entry of safeEntries) {
    const path = normalizePath(entry.name);
    const name = path.split('/').pop()!;

    // Walk to (and create) the parent directories, then the file itself.
    const segments = path.split('/').filter(Boolean);
    segments.pop();
    let dir = root;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }
    const handle = await dir.getFileHandle(name, { create: true });

    const writable = await handle.createWritable();
    if (isTextPath(path)) {
      await writable.write(await entry.async('string'));
    } else {
      // TS 5.7+: copy into a plain-ArrayBuffer Uint8Array for write().
      await writable.write(new Uint8Array(await entry.async('uint8array')));
    }
    await writable.close();
  }

  // Load the freshly written folder into the editor and compile main.tex.
  const opened = await openProjectFolder(root);
  if (opened) void compileProject();
  return opened;
}
