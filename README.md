# PWLaTeX

A 100% client-side, backend-free LaTeX editor. Open a folder from your disk,
edit multi-file projects in a CodeMirror 6 editor, and compile **real PDFs in
the browser** with a WebAssembly build of TeX Live ([texlyre-busytex](https://www.npmjs.com/package/texlyre-busytex))
running inside a Web Worker. No server, no upload — nothing leaves your machine.

> PWLaTeX = Progressive Web App LaTeX editor, built with AI-integration
> extensions in mind (see *Architecture*).

## Requirements

- **Desktop Chromium browser** (Chrome, Edge, Opera ≥ 86) — the app is built
  on the native [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API)
  for opening folders and saving files back to disk.
- ~1 GB free disk space for the WASM engine + TeX Live data packages
  (downloaded once, cached by the browser afterwards).

## Getting started

```bash
npm install                # also downloads the busytex assets (see below)
npm run dev                # → http://localhost:5173
```

The WASM engine assets (~686 MB, git-ignored) are fetched into
`public/core/busytex` by the `postinstall` hook. To fetch them manually:

```bash
npm run download-assets    # = texlyre-busytex download-assets ./public/core
```

## Usage

1. **Open folder** — pick a LaTeX project directory (`main.tex` at the root
   is detected automatically as the root document).
2. **Edit** — `.tex/.sty/.cls/.bib/.txt` files open as text; images and PDFs
   are cached as binary inputs for the compiler.
3. **Ctrl/Cmd+S** — saves the active file to disk *and* compiles the project.
   The **Compile** button does the same without saving.
4. The PDF preview renders in the right pane; download it or open it in a new
   tab. The engine log (with `!` error lines) is available at the bottom.

Multi-file projects (`\input`, `\include`) and BibTeX (when a `.bib` file is
present) are supported — all cached files are handed to the engine on every
compile.

### Citation search & insertion (Phase 2)

1. Press **Ctrl/Cmd+Shift+C** (or the **References** toolbar button) with a
   project open.
2. Type a query — results appear after a 350 ms debounce from **OpenAlex**
   or **Crossref** (toggle providers in the modal). Both APIs are queried
   directly from the browser; nothing is proxied through a server.
3. Click **Insert** on a result:
   - `\cite{Key}` is inserted at the editor cursor;
   - the BibTeX entry is appended to the project's `.bib` file — the one the
     main document references (`\bibliography{…}` / `\addbibresource{…}`),
     else `references.bib`/`refs.bib`, else any `.bib`; if none exists a new
     `references.bib` is created in the root (duplicate keys are never
     appended twice);
   - if the main document has no bibliography command at all,
     `\bibliographystyle{plain}` + `\bibliography{references}` are wired in
     before `\end{document}` so the reference actually renders;
   - all touched files are written back to disk and the project recompiles.

Citation keys follow `FirstAuthorLastNameYearFirstSignificantWord`
(e.g. `He2016Deep` for He et al., *Deep Residual Learning for Image
Recognition*), sanitized to ASCII alphanumerics. BibTeX entries are built
directly from the normalized API metadata — no `doi.org` redirects (which
would fail CORS in the browser).

> Browser note: on Chrome, `Ctrl+Shift+C` may be reserved for DevTools; the
> toolbar button always works.

### Project portability (Phase 2)

- **Export ZIP** packs every cached file (sources and binary assets, relative
  paths preserved) via JSZip entirely in the browser and downloads
  `${projectName}.zip`.
- **Import ZIP** unpacks a chosen `.zip` into an **empty** local folder (you
  pick it with the native directory picker), writes every entry to disk, then
  loads the folder into the editor and compiles its main document.

## Architecture

```
┌─────────────┬──────────────────────┬──────────────────┐
│  FileTree   │  Editor (CodeMirror) │  PDF preview     │
│             │                      │  (blob URL)      │
└──────┬──────┴──────────┬───────────┴────────▲─────────┘
       │                 │                     │ pdf bytes
       ▼                 ▼                     │
┌──────────────────────────────┐   ┌───────────┴──────────┐
│ src/lib/fileSystem.ts        │   │ src/lib/compiler.ts  │
│ normalized in-memory cache:  │──▶│ BusyTexRunner (WASM, │
│ Map<path, {content, handle,  │   │ Web Worker) +        │
│ isBinary}>  ·  FS Access API │   │ PdfLatex             │
└──────────────────────────────┘   └──────────────────────┘
        ▲                   ▲                        ▲
        │ cite insert +     │ \cite{key} at cursor   │ auto-recompile
        │ .bib append/create │                        │
┌───────┴───────────────────┴────────────────────────┴───┐
│ src/lib/references.ts (OpenAlex/Crossref → AcademicPaper│
│ → paperToBibTeX)  ·  citations.ts  ·  zipService.ts    │
└─────────────────────────────────────────────────────────┘
```

Two architectural invariants, kept for future AI & citation extensions:

1. **The `EditorView` is exposed** through the shared `editorView` store
   (`src/lib/editorState.ts`) — external modules can read cursor positions
   and dispatch transactions without touching the Editor component.
2. **The file cache is the single source of truth** — the normalized
   `Map<string, ProjectFile>` in `src/lib/fileSystem.ts` mirrors every
   keystroke, which makes multi-file compilation instant and gives future
   LLM context builders a synchronous query surface over the whole project.

A dev-only bridge (`window.__pwlatex`, `src/lib/debug.ts`) exposes these
modules — plus the Phase 2 citation search/insert and ZIP export functions —
for E2E tests and tooling experiments; it is never included in production
builds. `seedOpfsProject()` seeds a project into the Origin Private File
System so tests can run the full open → edit → cite → compile loop without
the (non-automatable) native directory picker.

## Data packages

| Package | Size | Role |
| --- | --- | --- |
| `texlive-basic` | ~91 MB | core LaTeX (bundled with the engine) |
| `texlive-recommended` | ~196 MB | standard packages — **preloaded** (amsmath, graphicx, geometry, hyperref, booktabs, …) |
| `texlive-extra` | ~334 MB | long tail, fetched lazily on demand |

The first compile downloads `texlive-recommended` (~196 MB) with a progress
bar; the browser Cache API keeps it for subsequent sessions.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run build` | Production build |
| `npm run check` | `svelte-check` + `tsc` |
| `npm run download-assets` | Fetch busytex WASM + TeX Live data into `public/core` |

## License

See [LICENSE](LICENSE).
