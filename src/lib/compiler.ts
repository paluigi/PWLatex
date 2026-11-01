/**
 * compiler.ts
 *
 * Real WebAssembly LaTeX compilation — no mocks, no server.
 *
 * A single `BusyTexRunner` (texlyre-busytex: a WASM build of TeX Live) runs
 * inside a Web Worker. The engine assets live under `/core/busytex` in the
 * Vite public folder (git-ignored; restored via `npm run download-assets`).
 *
 * Data-package strategy:
 * - `texlive-recommended.js` (~192 MB) is preloaded at initialization. It
 *   covers everything a standard article/report needs (amsmath, graphicx,
 *   geometry, hyperref, booktabs, …). The browser Cache API keeps it after
 *   the first download, so this cost is paid once per origin.
 * - `texlive-extra.js` is registered as a lazily-fetched catalog package for
 *   the long tail.
 *
 * Compilation input comes straight from the normalized in-memory file cache
 * (`fileSystem.ts`), so multi-file projects compile instantly with the exact
 * contents of the editor buffers — even unsaved ones.
 */

import { writable, get } from 'svelte/store';
import { BusyTexRunner, PdfLatex } from 'texlyre-busytex';
import type { CompileResult, FileInput } from 'texlyre-busytex';
import { files, mainTexPath, directoryHandle, saveActiveFile } from './fileSystem';

/** Where the busytex engine + TeX Live data packages are served from. */
const BUSYTEX_BASE_PATH = '/core/busytex';

// ---------------------------------------------------------------------------
// Public reactive state
// ---------------------------------------------------------------------------

export type EngineStatus = 'not-ready' | 'downloading' | 'ready' | 'error';
export type CompileStatus = 'idle' | 'running' | 'ok' | 'error';

/** Lifecycle of the WASM engine itself (download + worker boot). */
export const engineStatus = writable<EngineStatus>('not-ready');

/** Engine download progress while `engineStatus === 'downloading'`. */
export const engineProgress = writable<{ percent: number; loaded: number; total: number } | null>(null);

/** Lifecycle of the most recent compile. */
export const compileStatus = writable<CompileStatus>('idle');

/** Wall-clock duration of the most recent successful compile, in ms. */
export const lastCompileMs = writable<number | null>(null);

/** Object URL of the most recent successful PDF (revoked on replacement). */
export const pdfUrl = writable<string | null>(null);

/** Suggested download filename for the most recent PDF, e.g. `"main.pdf"`. */
export const pdfName = writable<string | null>(null);

/** Human-facing message when a compile fails outright (engine/throw). */
export const compileError = writable<string | null>(null);

/** Tail of the TeX engine log from the most recent compile. */
export const logText = writable<string>('');

/** `!`-prefixed error lines extracted from the most recent log. */
export const logErrors = writable<string[]>([]);

// ---------------------------------------------------------------------------
// Engine singleton
// ---------------------------------------------------------------------------

let runner: BusyTexRunner | null = null;
let pdfLatex: PdfLatex | null = null;
let initPromise: Promise<void> | null = null;

/** Download progress events also fire during compile (lazy catalog fetches). */
function handleDownloadProgress(p: { percent: number; loaded: number; total: number }): void {
  engineProgress.set(p);
}

/**
 * Boot the WASM engine (idempotent, concurrent-safe). Downloads
 * `texlive-recommended` data on first use — watch `engineProgress` for UI.
 */
export function ensureEngine(): Promise<void> {
  if (!initPromise) {
    engineStatus.set('downloading');
    engineProgress.set(null);

    runner = new BusyTexRunner({
      busytexBasePath: BUSYTEX_BASE_PATH,
      preloadDataPackages: [`${BUSYTEX_BASE_PATH}/texlive-recommended.js`],
      catalogDataPackages: [`${BUSYTEX_BASE_PATH}/texlive-extra.js`],
      verbose: import.meta.env.DEV,
      onDownloadProgress: handleDownloadProgress,
    });

    initPromise = runner
      .initialize(true) // true → run TeX inside a Web Worker, keep the UI responsive
      .then(() => {
        pdfLatex = new PdfLatex(runner!);
        engineStatus.set('ready');
        engineProgress.set(null);
      })
      .catch((err) => {
        // Allow a retry after a network hiccup.
        runner?.terminate();
        runner = null;
        pdfLatex = null;
        initPromise = null;
        engineStatus.set('error');
        throw err;
      });
  }
  return initPromise;
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

/** Lines of a TeX log that represent errors (`!` prefix), wrapped for display. */
function extractLogErrors(log: string): string[] {
  const errors: string[] = [];
  for (const line of log.split(/\r?\n/)) {
    if (line.startsWith('!')) errors.push(line);
  }
  return errors;
}

/** Keep the last ~120 lines of the engine log — enough context, bounded. */
function logTail(log: string, maxLines = 120): string {
  const lines = log.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
}

let currentPdfUrl: string | null = null;

function publishPdf(bytes: Uint8Array, name: string): void {
  if (currentPdfUrl) URL.revokeObjectURL(currentPdfUrl);
  // Copy into a fresh Uint8Array backed by a plain ArrayBuffer — the engine's
  // Uint8Array<ArrayBufferLike> is not assignable to BlobPart under TS 5.7+.
  currentPdfUrl = URL.createObjectURL(
    new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }),
  );
  pdfUrl.set(currentPdfUrl);
  pdfName.set(name);
}

function clearPdf(): void {
  if (currentPdfUrl) URL.revokeObjectURL(currentPdfUrl);
  currentPdfUrl = null;
  pdfUrl.set(null);
  pdfName.set(null);
}

/**
 * Compile the whole project from the in-memory cache using the real WASM
 * engine. Returns the raw `CompileResult` (also mirrored into the stores
 * above) or null when there is nothing to compile / the engine failed.
 */
export async function compileProject(): Promise<CompileResult | null> {
  const fileMap = get(files);
  const main = get(mainTexPath);
  if (!main) {
    compileStatus.set('error');
    compileError.set('No .tex file found in this project.');
    return null;
  }
  const mainRecord = fileMap.get(main);
  if (!mainRecord || mainRecord.isBinary) {
    compileStatus.set('error');
    compileError.set(`Main document "${main}" is missing or binary.`);
    return null;
  }

  compileStatus.set('running');
  compileError.set(null);
  const startedAt = performance.now();

  try {
    await ensureEngine();
  } catch (err) {
    compileStatus.set('error');
    compileError.set(`Failed to start the WASM engine: ${(err as Error).message}`);
    return null;
  }

  // The engine's entry point is the main document's *content*; every other
  // cached file rides along as an additional input (text as strings, images
  // and embedded PDFs as raw bytes).
  const additionalFiles: FileInput[] = [];
  for (const record of fileMap.values()) {
    if (record.path === main) continue;
    additionalFiles.push({ path: record.path, content: record.content });
  }

  const hasBibliography = [...fileMap.keys()].some((p) => p.toLowerCase().endsWith('.bib'));

  let result: CompileResult;
  try {
    result = await pdfLatex!.compile({
      input: mainRecord.content as string,
      mainTexPath: main,
      additionalFiles,
      bibtex: hasBibliography,
      rerun: true, // resolve cross-references and the table of contents
      verbose: 'info',
    });
  } catch (err) {
    compileStatus.set('error');
    compileError.set(`Compilation failed: ${(err as Error).message}`);
    logText.set('');
    logErrors.set([]);
    return null;
  }

  logText.set(logTail(result.log));
  logErrors.set(extractLogErrors(result.log));

  if (result.success && result.pdf) {
    publishPdf(result.pdf, main.replace(/\.tex$/i, '.pdf'));
    lastCompileMs.set(Math.round(performance.now() - startedAt));
    compileStatus.set('ok');
  } else {
    clearPdf();
    lastCompileMs.set(null);
    compileStatus.set('error');
    compileError.set(
      extractLogErrors(result.log)[0] ?? 'Compilation failed — see the log for details.',
    );
  }
  return result;
}

/**
 * The Ctrl+S pipeline: persist the active buffer to disk via its file handle,
 * then compile. The compiler always reads the in-memory cache (which mirrors
 * every keystroke), so the disk write is purely for persistence.
 */
export async function saveAndCompile(): Promise<void> {
  await saveActiveFile();
  await compileProject();
}

// A new project means the old preview is stale.
directoryHandle.subscribe((handle) => {
  if (!handle) {
    clearPdf();
    compileStatus.set('idle');
    compileError.set(null);
    logText.set('');
    logErrors.set([]);
  }
});
