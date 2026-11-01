<script lang="ts">
  /**
   * PdfViewer.svelte — renders the compiled PDF via an object URL in the
   * browser's native PDF viewer, with engine/compile status while busy.
   * The bytes come from the real WASM compile in compiler.ts — nothing here
   * is ever mocked.
   */
  import {
    pdfUrl,
    pdfName,
    compileStatus,
    engineStatus,
    engineProgress,
    lastCompileMs,
    compileError,
  } from '../compiler';
  import { Download, ExternalLink, FileText, LoaderCircle, TriangleAlert } from 'lucide-svelte';

  function downloadPdf(): void {
    const url = $pdfUrl;
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = $pdfName ?? 'document.pdf';
    a.click();
  }

  function openInNewTab(): void {
    if ($pdfUrl) window.open($pdfUrl, '_blank');
  }

  const busy = $derived($compileStatus === 'running' || $engineStatus === 'downloading');
</script>

<div class="pdf-pane">
  <div class="pdf-header">
    <div class="title">
      {#if $pdfName}
        <FileText size={13} />
        <span class="name">{$pdfName}</span>
        {#if $lastCompileMs !== null}<span class="meta">· {$lastCompileMs} ms</span>{/if}
      {:else}
        <span class="meta">PDF preview</span>
      {/if}
    </div>
    <div class="actions">
      {#if $pdfUrl}
        <button class="icon-btn" title="Open in new tab" onclick={openInNewTab}>
          <ExternalLink size={14} />
        </button>
        <button class="icon-btn" title="Download PDF" onclick={downloadPdf}>
          <Download size={14} />
        </button>
      {/if}
    </div>
  </div>

  <div class="pdf-body">
    {#if $pdfUrl && !busy}
      <iframe title="Compiled PDF preview" src={$pdfUrl}></iframe>
    {:else}
      <div class="placeholder">
        {#if $engineStatus === 'downloading'}
          <span class="spin"><LoaderCircle size={22} /></span>
          <p class="strong">Downloading TeX engine data…</p>
          {#if $engineProgress}
            <div class="progress">
              <div class="bar" style="width: {Math.min(100, $engineProgress.percent)}%"></div>
            </div>
            <p class="muted">
              {$engineProgress.percent.toFixed(0)}% · {($engineProgress.loaded / 1048576).toFixed(0)} /
              {($engineProgress.total / 1048576).toFixed(0)} MB — first run only, cached afterwards
            </p>
          {/if}
        {:else if $compileStatus === 'running'}
          <span class="spin"><LoaderCircle size={22} /></span>
          <p class="strong">Compiling with pdflatex (WebAssembly)…</p>
          <p class="muted">First compilation is slower while TeX Live warms up.</p>
        {:else if $compileStatus === 'error'}
          <span class="err"><TriangleAlert size={22} /></span>
          <p class="strong">Compilation failed</p>
          {#if $compileError}<p class="muted mono">{$compileError}</p>{/if}
          <p class="muted">Open the log panel below for the full engine output.</p>
        {:else}
          <span class="muted-icon"><FileText size={22} /></span>
          <p class="strong">No PDF yet</p>
          <p class="muted">Open a project and press <kbd>Ctrl</kbd>+<kbd>S</kbd> to compile.</p>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .pdf-pane {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-width: 0;
    background: var(--bg-1);
  }

  .pdf-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 34px;
    padding: 0 8px 0 12px;
    border-bottom: 1px solid var(--border-0);
    background: var(--bg-2);
    flex-shrink: 0;
  }

  .title {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    font-size: 12.5px;
    color: var(--text-1);
  }

  .name {
    color: var(--text-0);
    font-family: var(--font-mono);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .meta {
    color: var(--text-2);
    white-space: nowrap;
  }

  .actions {
    display: flex;
    gap: 2px;
  }

  .icon-btn {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: 6px;
    color: var(--text-1);
  }

  .icon-btn:hover {
    background: var(--bg-3);
    color: var(--text-0);
  }

  .pdf-body {
    flex: 1;
    min-height: 0;
    position: relative;
  }

  iframe {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    border: none;
    background: #fff;
  }

  .placeholder {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 24px;
    text-align: center;
    color: var(--text-1);
  }

  .strong {
    color: var(--text-0);
    font-weight: 500;
    margin: 0;
  }

  .muted {
    color: var(--text-2);
    font-size: 12.5px;
    margin: 0;
    max-width: 360px;
  }

  .mono {
    font-family: var(--font-mono);
  }

  .muted-icon {
    color: var(--text-2);
  }

  .err {
    color: var(--error);
  }

  .spin {
    display: grid;
    place-items: center;
    color: var(--accent);
    animation: spin 1s linear infinite;
  }

  kbd {
    padding: 1px 5px;
    border: 1px solid var(--border-1);
    border-bottom-width: 2px;
    border-radius: 4px;
    background: var(--bg-2);
    font-family: var(--font-mono);
    font-size: 11px;
  }

  .progress {
    width: 260px;
    max-width: 80%;
    height: 6px;
    border-radius: 4px;
    background: var(--bg-3);
    overflow: hidden;
  }

  .bar {
    height: 100%;
    border-radius: 4px;
    background: var(--accent);
    transition: width 200ms ease;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
