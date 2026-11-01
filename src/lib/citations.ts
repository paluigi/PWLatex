/**
 * citations.ts
 *
 * The full "Insert citation" pipeline behind the reference modal:
 *
 *   1. Insert `\cite{key}` at the CodeMirror cursor via the shared
 *      `editorView` store (architectural rule #1 — no component reach-ins).
 *   2. Append the BibTeX entry to the project's `.bib` file — creating one
 *      if the project has none — while guaranteeing no duplicate keys.
 *   3. Persist the touched `.tex` / `.bib` files back to disk through their
 *      `FileSystemFileHandle`s.
 *   4. Focus the editor and trigger a re-compilation so the new reference
 *      renders in the PDF preview.
 */

import { get } from 'svelte/store';
import { files, activeFilePath, mainTexPath, saveFile, createFile, updateFileContent, normalizePath } from './fileSystem';
import type { ProjectFile } from './fileSystem';
import { compileProject } from './compiler';
import { editorView } from './editorState';
import { paperToBibTeX } from './references';
import type { AcademicPaper } from './references';

export type InsertOutcome =
  | { ok: true; key: string; bibPath: string; bibCreated: boolean }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// .bib resolution & duplicate detection
// ---------------------------------------------------------------------------

/** Bibliography names referenced by the main document (`\bibliography{a,b}` / `\addbibresource{x.bib}`). */
function referencedBibNames(tex: string): string[] {
  const names: string[] = [];
  for (const match of tex.matchAll(/\\bibliography\{([^}]*)\}/g)) {
    for (const name of match[1].split(',')) {
      const trimmed = name.trim();
      if (trimmed) names.push(trimmed);
    }
  }
  for (const match of tex.matchAll(/\\addbibresource\{([^}]*)\}/g)) {
    const trimmed = match[1].trim();
    if (trimmed) names.push(trimmed);
  }
  return names;
}

function withBibExtension(name: string): string {
  return name.toLowerCase().endsWith('.bib') ? name : `${name}.bib`;
}

/**
 * Pick the .bib file a new entry belongs in:
 * 1. the file the main document already references,
 * 2. a conventional root file (references.bib / refs.bib / bibliography.bib),
 * 3. any other .bib in the project.
 */
function resolveExistingBibPath(map: Map<string, ProjectFile>, mainContent: string | null): string | null {
  if (mainContent) {
    for (const name of referencedBibNames(mainContent)) {
      const normalized = normalizePath(name);
      for (const candidate of [withBibExtension(normalized), normalized]) {
        if (map.has(candidate)) return candidate;
      }
    }
  }
  for (const conventional of ['references.bib', 'refs.bib', 'bibliography.bib']) {
    const hit = [...map.keys()].find((path) => path.toLowerCase() === conventional);
    if (hit) return hit;
  }
  return [...map.keys()].find((path) => path.toLowerCase().endsWith('.bib')) ?? null;
}

/**
 * True when `content` already declares an entry with this key. Classic
 * BibTeX matches keys case-insensitively, so compare that way too.
 */
export function bibContainsKey(content: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`@\\w+\\{\\s*${escaped}\\s*,`, 'i').test(content);
}

// ---------------------------------------------------------------------------
// Insertion pipeline
// ---------------------------------------------------------------------------

/**
 * Insert a `\cite{…}` command for `paper` at the editor cursor, manage the
 * project's .bib file, persist everything, and kick off a re-compile.
 */
export async function insertCitation(paper: AcademicPaper): Promise<InsertOutcome> {
  const view = get(editorView);
  if (!view) return { ok: false, error: 'No editor is open.' };

  const texPath = get(activeFilePath);
  if (!texPath) return { ok: false, error: 'Open a .tex file in the editor before inserting a citation.' };
  if (texPath.toLowerCase().endsWith('.bib')) {
    return { ok: false, error: 'The active file is a .bib bibliography — open a .tex document first.' };
  }

  const map = get(files);
  const texRecord = map.get(texPath);
  if (!texRecord || texRecord.isBinary) {
    return { ok: false, error: `"${texPath}" is not an editable text file.` };
  }

  const { key, bibtex } = paperToBibTeX(paper);
  const mainPath = get(mainTexPath);

  // --- 1. Insert \cite{key} at the current selection ---
  // This MUST be the first mutation: rewriting the active file's cache entry
  // (auto-wiring below) resets the EditorState and would move the cursor to 0.
  const cite = `\\cite{${key}}`;
  const sel = view.state.selection.main;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: cite },
    selection: { anchor: sel.from + cite.length },
    scrollIntoView: true,
    userEvent: 'input.paste',
  });
  // The editor's update listener synced the cache synchronously during dispatch.

  // --- 2. .bib management ---
  const mainRecord = mainPath ? get(files).get(mainPath) : null;
  const mainContent = mainRecord && !mainRecord.isBinary ? (mainRecord.content as string) : null;

  let bibPath = resolveExistingBibPath(get(files), mainContent);
  let bibCreated = false;

  if (bibPath) {
    const current = get(files).get(bibPath)!.content as string;
    if (!bibContainsKey(current, key)) {
      const updated = `${current.replace(/\s+$/, '')}\n\n${bibtex}\n`;
      updateFileContent(bibPath, updated);
      await saveFile(bibPath, updated);
    }
  } else {
    // No .bib anywhere: create one — named after what the main document
    // references, otherwise the conventional references.bib in the root.
    bibPath = mainContent
      ? withBibExtension(normalizePath(referencedBibNames(mainContent)[0] ?? 'references.bib'))
      : 'references.bib';
    await createFile(bibPath, `${bibtex}\n`);
    bibCreated = true;
  }

  // --- 3. Auto-wire the bibliography into the main document if needed ---
  // Without a \bibliography/\addbibresource command the new \cite would
  // render as "[?]" — so point the main document at the .bib we just used
  // whenever it references no bibliography at all.
  if (mainContent && !/\\(bibliography|addbibresource|nobibliography)\s*\{/.test(mainContent)) {
    const styleLine = mainContent.includes('\\bibliographystyle') ? '' : '\\bibliographystyle{plain}\n';
    const wiring = `${styleLine}\\bibliography{${bibPath.replace(/\.bib$/i, '')}}\n`;
    const endIdx = mainContent.lastIndexOf('\\end{document}');

    if (mainPath === texPath) {
      // The main document is the visible one: route the edit through the
      // editor itself so the cursor/undo history survive (a cache-level
      // rewrite would swap in a fresh EditorState and jump to position 0).
      // `mainContent` was read after the cite dispatch, so `endIdx` already
      // refers to the current document.
      view.dispatch({
        changes: {
          from: endIdx === -1 ? view.state.doc.length : endIdx,
          insert: endIdx === -1 ? `\n\n${wiring}` : wiring,
        },
      });
    } else {
      const wired =
        endIdx === -1
          ? `${mainContent}\n\n${wiring}`
          : `${mainContent.slice(0, endIdx)}${wiring}\n${mainContent.slice(endIdx)}`;
      updateFileContent(mainRecord!.path, wired);
      await saveFile(mainRecord!.path, wired);
    }
  }

  // --- 4. Persist the .tex and refocus + recompile ---
  await saveFile(texPath);
  view.focus();
  void compileProject();

  return { ok: true, key, bibPath, bibCreated };
}
