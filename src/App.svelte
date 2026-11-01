<script lang="ts">
  /**
   * App.svelte — application shell.
   *
   * 3-column split: FileTree | Editor | PdfViewer, with a toolbar on top and
   * a collapsible engine-log panel at the bottom. Global shortcuts:
   * Ctrl/Cmd+S saves + compiles; Ctrl/Cmd+Shift+C opens the citation search.
   */
  import { openProjectFolder, projectName, directoryHandle, isScanning, fsError } from './lib/fileSystem';
  import { compileProject, saveAndCompile, compileStatus, engineStatus, logText, logErrors, compileError } from './lib/compiler';
  import { exportProjectZip, importProjectZip } from './lib/zipService';
  import FileTree from './lib/components/FileTree.svelte';
  import Editor from './lib/components/Editor.svelte';
  import PdfViewer from './lib/components/PdfViewer.svelte';
  import CitationModal from './lib/components/CitationModal.svelte';
  import {
    Archive, ArchiveRestore, BookOpenText, CircleAlert, FolderOpen, LoaderCircle,
    ChevronDown, ChevronUp, Play, Sigma, X,
  } from 'lucide-svelte';

  const hasProject = $derived($directoryHandle !== null);

  let logOpen = $state(false);

  /** Citation search modal (mounted only while open). */
  let citationOpen = $state(false);

  /** Which ZIP operation is running, if any. */
  let portOp = $state<'export' | 'import' | null>(null);
  const portBusy = $derived(portOp !== null);
  /** Last portability/citation error surfaced as a dismissible strip. */
  let actionError = $state<string | null>(null);

  let zipInput: HTMLInputElement | undefined = $state();

  // Auto-reveal the log when a compile fails.
  $effect(() => {
    if ($compileStatus === 'error') logOpen = true;
  });

  function onGlobalKeydown(e: KeyboardEvent): void {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      if (e.defaultPrevented) return; // already handled inside CodeMirror
      e.preventDefault();
      if (hasProject) void saveAndCompile();
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      if (hasProject && !citationOpen) citationOpen = true;
    }
  }

  async function onExportZip(): Promise<void> {
    actionError = null;
    portOp = 'export';
    try {
      await exportProjectZip();
    } catch (err) {
      actionError = (err as Error).message;
    } finally {
      portOp = null;
    }
  }

  function onImportZipClick(): void {
    actionError = null;
    zipInput?.click();
  }

  async function onZipChosen(e: Event): Promise<void> {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // allow picking the same file again later
    if (!file) return;
    actionError = null;
    portOp = 'import';
    try {
      await importProjectZip(file);
    } catch (err) {
      actionError = (err as Error).message;
    } finally {
      portOp = null;
    }
  }

  const compileDisabled = $derived(!hasProject || $compileStatus === 'running' || $engineStatus === 'downloading');
  const compileBusy = $derived($compileStatus === 'running' || $engineStatus === 'downloading');
</script>

<svelte:window onkeydown={onGlobalKeydown} />

<div class="app">
  <header>
    <div class="brand">
      <span class="logo"><Sigma size={16} /></span>
      <span class="title">PWLaTeX</span>
      <span class="badge">local-first · WASM</span>
    </div>

    <div class="toolbar">
      <button class="btn" onclick={() => void openProjectFolder()}>
        <FolderOpen size={14} />
        {$projectName ? $projectName : 'Open folder'}
      </button>
      <button class="btn primary" disabled={compileDisabled} onclick={() => void compileProject()}>
        {#if compileBusy}
          <span class="spin"><LoaderCircle size={14} /></span>
          Compiling…
        {:else}
          <Play size={14} />
          Compile
        {/if}
      </button>
      <button
        class="btn"
        disabled={!hasProject}
        onclick={() => (citationOpen = true)}
        title="Search references (Ctrl/Cmd+Shift+C)"
      >
        <BookOpenText size={14} />
        References
      </button>
      <button class="btn" disabled={!hasProject || portBusy} onclick={() => void onExportZip()}>
        {#if portOp === 'export'}
          <span class="spin"><LoaderCircle size={14} /></span>
        {:else}
          <Archive size={14} />
        {/if}
        Export ZIP
      </button>
      <button class="btn" disabled={portBusy} onclick={onImportZipClick}>
        {#if portOp === 'import'}
          <span class="spin"><LoaderCircle size={14} /></span>
        {:else}
          <ArchiveRestore size={14} />
        {/if}
        Import ZIP
      </button>
      <span class="shortcut-hint">Ctrl+S compile · Ctrl+Shift+C cite</span>
    </div>
    <input
      type="file"
      accept=".zip,application/zip,application/x-zip-compressed"
      hidden
      bind:this={zipInput}
      onchange={(e) => void onZipChosen(e)}
      aria-hidden="true"
      tabindex={-1}
    />

    <div class="status">
      {#if $compileStatus === 'ok'}
        <span class="pill ok">PDF ready</span>
      {:else if $compileStatus === 'error'}
        <span class="pill err">error</span>
      {:else if $engineStatus === 'downloading'}
        <span class="pill busy">fetching engine</span>
      {/if}
    </div>
  </header>

  {#if actionError}
    <div class="action-error" role="alert">
      <CircleAlert size={13} />
      <span class="msg">{actionError}</span>
      <button class="dismiss" onclick={() => (actionError = null)} aria-label="Dismiss">
        <X size={12} />
      </button>
    </div>
  {/if}

  {#if hasProject}
    <main class="split">
      <aside class="col-tree"><FileTree /></aside>
      <section class="col-editor"><Editor /></section>
      <section class="col-pdf"><PdfViewer /></section>
    </main>
  {:else}
    <main class="empty">
      <div class="card">
        <span class="card-logo"><Sigma size={26} /></span>
        <h1>PWLaTeX</h1>
        <p class="lead">
          A 100% client-side LaTeX editor. Your files never leave this machine: projects open straight
          from disk, and PDFs are compiled in your browser by a WebAssembly TeX&nbsp;Live engine.
        </p>
        <button class="btn primary big" onclick={() => void openProjectFolder()} disabled={$isScanning}>
          {#if $isScanning}
            <span class="spin"><LoaderCircle size={15} /></span> Scanning…
          {:else}
            <FolderOpen size={15} /> Open project folder
          {/if}
        </button>
        <p class="fine">Requires a desktop Chromium browser (Chrome, Edge, Opera) for the File System Access API.</p>
        {#if $fsError}
          <p class="error-note">{$fsError}</p>
        {/if}
        <ul class="facts">
          <li>Multi-file projects with <code>\input</code>/<code>\include</code> and BibTeX</li>
          <li>Search &amp; insert citations from OpenAlex and Crossref (<code>Ctrl+Shift+C</code>)</li>
          <li>Export / import whole projects as <code>.zip</code> — nothing ever leaves your machine</li>
          <li>CodeMirror 6 editor with LaTeX highlighting</li>
          <li>Real <code>pdflatex</code> in a Web Worker — first run downloads ~200&nbsp;MB of TeX Live, cached by the browser</li>
        </ul>
      </div>
    </main>
  {/if}

  {#if citationOpen}
    <CitationModal onclose={() => (citationOpen = false)} />
  {/if}

  {#if logOpen && ($logText || $logErrors.length > 0)}
    <footer class="log">
      <button class="log-header" onclick={() => (logOpen = false)}>
        <span class="log-title">
          Engine log
          {#if $logErrors.length > 0}<span class="err-count">{$logErrors.length} error{$logErrors.length === 1 ? '' : 's'}</span>{/if}
          {#if $compileError && $compileStatus === 'error'}<span class="err-count">· {$compileError}</span>{/if}
        </span>
        <ChevronDown size={14} />
      </button>
      <div class="log-body">
        {#if $logErrors.length > 0}
          <pre class="errors">{#each $logErrors as line}<span>{line}</span>{/each}</pre>
        {/if}
        <pre class="tail">{$logText || '(empty log)'}</pre>
      </div>
    </footer>
  {:else if $logText || $logErrors.length > 0}
    <button class="log-collapsed" onclick={() => (logOpen = true)}>
      <span>Engine log</span>
      {#if $logErrors.length > 0}<span class="err-count">{$logErrors.length}</span>{/if}
      <ChevronUp size={14} />
    </button>
  {/if}
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    height: var(--header-h);
    padding: 0 14px;
    border-bottom: 1px solid var(--border-0);
    background: var(--bg-1);
    flex-shrink: 0;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
  }

  .logo {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: 7px;
    background: var(--accent-dim);
    color: var(--accent);
  }

  .title {
    font-weight: 650;
    letter-spacing: 0.01em;
  }

  .badge {
    padding: 2px 8px;
    border: 1px solid var(--border-1);
    border-radius: 999px;
    color: var(--text-2);
    font-size: 10.5px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 32px;
    padding: 0 12px;
    border: 1px solid var(--border-1);
    border-radius: var(--radius);
    background: var(--bg-2);
    color: var(--text-0);
    font-size: 13px;
    white-space: nowrap;
  }

  .btn:hover:not(:disabled) {
    background: var(--bg-3);
  }

  .btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .btn.primary {
    background: var(--accent-strong);
    border-color: transparent;
    color: #fff;
    font-weight: 550;
  }

  .btn.primary:hover:not(:disabled) {
    filter: brightness(1.1);
  }

  .btn.big {
    height: 40px;
    padding: 0 18px;
    font-size: 14px;
  }

  .shortcut-hint {
    color: var(--text-2);
    font-size: 11.5px;
    white-space: nowrap;
  }

  .status {
    display: flex;
    align-items: center;
    min-width: 90px;
    justify-content: flex-end;
  }

  .pill {
    padding: 3px 10px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.03em;
  }

  .pill.ok {
    background: rgba(74, 222, 128, 0.14);
    color: var(--success);
  }

  .pill.err {
    background: rgba(248, 113, 113, 0.14);
    color: var(--error);
  }

  .pill.busy {
    background: var(--accent-dim);
    color: var(--accent);
  }

  .action-error {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 6px 14px;
    border-bottom: 1px solid rgba(248, 113, 113, 0.35);
    background: rgba(248, 113, 113, 0.08);
    color: var(--error);
    font-size: 12.5px;
    flex-shrink: 0;
  }

  .action-error .msg {
    flex: 1;
    min-width: 0;
  }

  .action-error .dismiss {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: 5px;
    color: var(--error);
  }

  .action-error .dismiss:hover {
    background: rgba(248, 113, 113, 0.15);
  }

  main.split {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(210px, 260px) minmax(0, 1.25fr) minmax(0, 1fr);
  }

  .col-tree,
  .col-editor,
  .col-pdf {
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .col-editor {
    border-right: 1px solid var(--border-0);
  }

  .col-tree {
    border-right: 1px solid var(--border-0);
  }

  main.empty {
    flex: 1;
    min-height: 0;
    display: grid;
    place-items: center;
    background: radial-gradient(1200px 500px at 50% -10%, rgba(110, 168, 254, 0.07), transparent 60%);
  }

  .card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
    max-width: 480px;
    padding: 40px 36px;
    text-align: center;
  }

  .card-logo {
    display: grid;
    place-items: center;
    width: 52px;
    height: 52px;
    border-radius: 14px;
    background: var(--accent-dim);
    color: var(--accent);
  }

  h1 {
    margin: 0;
    font-size: 22px;
    letter-spacing: 0.01em;
  }

  .lead {
    margin: 0;
    color: var(--text-1);
  }

  .fine {
    margin: 0;
    color: var(--text-2);
    font-size: 12px;
  }

  .error-note {
    margin: 0;
    padding: 8px 12px;
    border: 1px solid rgba(248, 113, 113, 0.35);
    border-radius: var(--radius);
    color: var(--error);
    font-size: 12.5px;
  }

  .facts {
    margin: 6px 0 0;
    padding: 0;
    list-style: none;
    color: var(--text-2);
    font-size: 12.5px;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  code {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text-1);
  }

  footer.log {
    border-top: 1px solid var(--border-0);
    background: var(--bg-1);
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    max-height: 220px;
  }

  .log-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    color: var(--text-2);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .log-header:hover {
    color: var(--text-0);
  }

  .log-title {
    display: flex;
    align-items: center;
    gap: 8px;
    text-transform: none;
    letter-spacing: 0;
    font-size: 12px;
    font-weight: 500;
    color: var(--text-1);
  }

  .err-count {
    color: var(--error);
    font-size: 12px;
  }

  .log-body {
    overflow-y: auto;
    padding: 0 12px 10px;
  }

  pre {
    margin: 0 0 8px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
  }

  pre.errors {
    display: flex;
    flex-direction: column;
    gap: 2px;
    color: var(--error);
  }

  pre.tail {
    color: var(--text-1);
    opacity: 0.85;
  }

  .log-collapsed {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px;
    border-top: 1px solid var(--border-0);
    background: var(--bg-1);
    color: var(--text-2);
    font-size: 11px;
    flex-shrink: 0;
  }

  .log-collapsed:hover {
    color: var(--text-0);
  }

  .spin {
    display: inline-grid;
    place-items: center;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
