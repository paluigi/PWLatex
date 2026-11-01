/**
 * debug.ts — DEV ONLY (never imported in production builds; see main.ts).
 *
 * Installs `window.__pwlatex`, a small bridge over the app's public modules.
 * Two audiences:
 *
 * 1. E2E tests: the native directory picker cannot be automated, but the
 *    Origin Private File System yields real `FileSystemDirectoryHandle`s
 *    without any picker — `seedOpfsProject()` writes a project there and
 *    `openProjectFolder(handle)` opens it through the exact production path
 *    (scan → cache → edit → save → compile).
 *
 * 2. Future external tooling (AI completion providers, reference inserters):
 *    the same handles/stores are the integration points those tools will use.
 */

import { openProjectFolder, files, activeFilePath, directoryHandle, saveActiveFile } from './fileSystem';
import { compileProject, ensureEngine, saveAndCompile, compileStatus, engineStatus, pdfUrl } from './compiler';
import { editorView } from './editorState';
import { searchPapers, paperToBibTeX } from './references';
import { insertCitation } from './citations';
import { exportProjectZip } from './zipService';

/** Recursively remove every entry of an OPFS directory. */
async function clearOpfsDir(dir: FileSystemDirectoryHandle): Promise<void> {
  for await (const [name, handle] of dir.entries()) {
    await dir.removeEntry(name, { recursive: handle.kind === 'directory' });
  }
}

/**
 * Write `{ path: content }` into a fresh OPFS root and return its handle.
 * Nested paths (`sections/intro.tex`) create intermediate directories.
 */
export async function seedOpfsProject(project: Record<string, string>): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  const work = await root.getDirectoryHandle('pwlatex-e2e', { create: true });
  await clearOpfsDir(work);

  for (const [path, content] of Object.entries(project)) {
    const segments = path.split('/');
    const name = segments.pop()!;
    let dir = work;
    for (const segment of segments) dir = await dir.getDirectoryHandle(segment, { create: true });
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
  }
  return work;
}

export function installDebugHook(): void {
  (window as unknown as Record<string, unknown>).__pwlatex = {
    // Production paths
    openProjectFolder,
    compileProject,
    ensureEngine,
    saveActiveFile,
    saveAndCompile,
    seedOpfsProject,
    insertCitation, // Phase 2: cursor-level \cite + .bib management
    searchPapers, // Phase 2: OpenAlex/Crossref search
    paperToBibTeX, // Phase 2: BibTeX generation
    exportProjectZip, // Phase 2: project portability (triggers a download)
    // Live state (stores)
    stores: { files, activeFilePath, directoryHandle, compileStatus, engineStatus, pdfUrl },
    editorView,
  };
}
