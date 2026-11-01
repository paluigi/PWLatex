<script lang="ts">
  /**
   * CitationModal.svelte — academic reference search & insertion.
   *
   * Opened from the toolbar ("References") or Ctrl/Cmd+Shift+C, and mounted
   * only while open (App renders it inside `{#if}`), so every open starts
   * from a clean state. The search input is debounced (350 ms) and switches
   * between OpenAlex and Crossref; clicking "Insert" runs the pipeline in
   * `citations.ts`: `\cite{key}` at the cursor, the BibTeX entry appended to
   * the project's .bib (created if missing), files saved, and a re-compile.
   */
  import { BookOpenText, CircleAlert, LoaderCircle, Search, X } from 'lucide-svelte';
  import { searchPapers, citationKey } from '../references';
  import type { AcademicPaper, SearchSource } from '../references';
  import { insertCitation } from '../citations';

  interface Props {
    onclose: () => void;
  }
  let { onclose }: Props = $props();

  /** Debounce window for the search input, per spec. */
  const DEBOUNCE_MS = 350;
  const MIN_QUERY = 2;

  let query = $state('');
  let source = $state<SearchSource>('openalex');
  let results = $state<AcademicPaper[]>([]);
  let searching = $state(false);
  /** True once any search has completed (drives the "no results" state). */
  let searched = $state(false);
  let searchError = $state<string | null>(null);
  let insertingId = $state<string | null>(null);
  let insertError = $state<string | null>(null);

  /** Svelte action: focus the search field as soon as the modal mounts. */
  function autofocus(el: HTMLElement): void {
    el.focus();
  }

  function onWindowKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') onclose();
  }

  // Debounced search. The effect re-runs on every keystroke / source switch;
  // its cleanup aborts the previous timer and any in-flight request.
  $effect(() => {
    const trimmed = query.trim();
    const activeSource = source;
    if (trimmed.length < MIN_QUERY) {
      results = [];
      searching = false;
      searched = false;
      searchError = null;
      return;
    }

    searching = true;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchPapers(trimmed, activeSource, controller.signal)
        .then((papers) => {
          if (controller.signal.aborted) return;
          results = papers;
          searching = false;
          searched = true;
          searchError = null;
        })
        .catch((err) => {
          if (controller.signal.aborted || (err as Error)?.name === 'AbortError') return;
          searchError = (err as Error).message;
          searching = false;
          results = [];
          searched = true;
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  });

  async function insert(paper: AcademicPaper): Promise<void> {
    if (insertingId !== null) return;
    insertingId = paper.id;
    insertError = null;
    try {
      const outcome = await insertCitation(paper);
      if (!outcome.ok) {
        insertError = outcome.error;
        return;
      }
      onclose(); // citations.ts already re-focused the editor + recompiled
    } catch (err) {
      insertError = (err as Error).message;
    } finally {
      insertingId = null;
    }
  }

  function authorsLine(paper: AcademicPaper): string {
    if (paper.authors.length === 0) return 'Unknown author';
    const shown = paper.authors.slice(0, 5).join(', ');
    return paper.authors.length > 5 ? `${shown} et al.` : shown;
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="backdrop" onclick={(e) => e.target === e.currentTarget && onclose()} role="presentation">
  <div class="modal" role="dialog" aria-modal="true" aria-label="Search academic references">
    <header class="modal-head">
      <span class="head-icon"><BookOpenText size={15} /></span>
      <span class="head-title">Search references</span>
      <button class="icon-btn" onclick={onclose} aria-label="Close" title="Close (Esc)">
        <X size={14} />
      </button>
    </header>

    <div class="search-row">
      <div class="search-box">
        <Search size={14} />
        <input
          use:autofocus
          type="text"
          bind:value={query}
          placeholder="Search papers by title, author, DOI…"
          spellcheck="false"
          aria-label="Search query"
        />
        {#if searching}<span class="spin"><LoaderCircle size={13} /></span>{/if}
      </div>

      <div class="source-toggle" role="tablist" aria-label="Metadata provider">
        <button
          role="tab"
          aria-selected={source === 'openalex'}
          class:active={source === 'openalex'}
          onclick={() => (source = 'openalex')}
        >
          OpenAlex
        </button>
        <button
          role="tab"
          aria-selected={source === 'crossref'}
          class:active={source === 'crossref'}
          onclick={() => (source = 'crossref')}
        >
          Crossref
        </button>
      </div>
    </div>

    {#if insertError}
      <p class="banner error" role="alert">
        <CircleAlert size={13} />
        {insertError}
      </p>
    {/if}
    {#if searchError}
      <p class="banner error" role="alert">
        <CircleAlert size={13} />
        {searchError}
      </p>
    {/if}

    <div class="results">
      {#each results as paper (paper.id)}
        <article class="result">
          <div class="result-main">
            <h3 class="title">{paper.title}</h3>
            <p class="meta">
              {authorsLine(paper)}
              {#if paper.year > 0}· {paper.year}{/if}
              {#if paper.venue}· <em>{paper.venue}</em>{/if}
            </p>
            {#if paper.doi}<p class="doi">{paper.doi}</p>{/if}
            <p class="key">→ \cite{citationKey(paper)}</p>
          </div>
          <button
            class="insert-btn"
            onclick={() => void insert(paper)}
            disabled={insertingId !== null}
            title={'Insert \\cite{…} at the cursor and add the entry to the project .bib'}
          >
            {#if insertingId === paper.id}
              <span class="spin"><LoaderCircle size={12} /></span>
              Inserting…
            {:else}
              Insert
            {/if}
          </button>
        </article>
      {:else}
        {#if searching}
          <div class="state">
            <span class="spin"><LoaderCircle size={18} /></span>
            <p>Searching {source === 'openalex' ? 'OpenAlex' : 'Crossref'}…</p>
          </div>
        {:else if searchError}
          <!-- the error banner above already describes the failure -->
        {:else if searched}
          <div class="state">
            <p>No results for “{query.trim()}”.</p>
            <p class="hint">Try a shorter query, fewer authors, or the other provider.</p>
          </div>
        {:else}
          <div class="state">
            <p class="hint">
              Type at least {MIN_QUERY} characters — results appear automatically.
            </p>
          </div>
        {/if}
      {/each}
    </div>

    <footer class="modal-foot">
      Entries are appended to the project's .bib (created if missing) ·
      <kbd>Esc</kbd> closes · <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> reopens
    </footer>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: grid;
    place-items: start center;
    padding: 8vh 16px 16px;
    background: rgba(8, 10, 14, 0.62);
    backdrop-filter: blur(2px);
  }

  .modal {
    display: flex;
    flex-direction: column;
    width: min(640px, 100%);
    max-height: 78vh;
    border: 1px solid var(--border-1);
    border-radius: 12px;
    background: var(--bg-1);
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
    overflow: hidden;
  }

  .modal-head {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border-0);
    flex-shrink: 0;
  }

  .head-icon {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: 7px;
    background: var(--accent-dim);
    color: var(--accent);
  }

  .head-title {
    font-weight: 600;
    font-size: 13.5px;
    flex: 1;
  }

  .icon-btn {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: 6px;
    color: var(--text-1);
  }

  .icon-btn:hover {
    background: var(--bg-3);
    color: var(--text-0);
  }

  .search-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 12px 0;
    flex-shrink: 0;
  }

  .search-box {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 34px;
    padding: 0 10px;
    border: 1px solid var(--border-1);
    border-radius: var(--radius);
    background: var(--bg-2);
    color: var(--text-2);
    min-width: 0;
  }

  .search-box:focus-within {
    border-color: var(--accent);
  }

  input {
    flex: 1;
    min-width: 0;
    border: none;
    outline: none;
    background: transparent;
    color: var(--text-0);
    font: inherit;
    font-size: 13px;
  }

  input::placeholder {
    color: var(--text-2);
  }

  .source-toggle {
    display: flex;
    border: 1px solid var(--border-1);
    border-radius: var(--radius);
    background: var(--bg-2);
    overflow: hidden;
    flex-shrink: 0;
  }

  .source-toggle button {
    padding: 0 12px;
    height: 34px;
    font-size: 12.5px;
    color: var(--text-2);
  }

  .source-toggle button.active {
    background: var(--accent-dim);
    color: var(--accent);
    font-weight: 600;
  }

  .banner {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 10px 12px 0;
    padding: 8px 10px;
    border: 1px solid rgba(248, 113, 113, 0.35);
    border-radius: var(--radius);
    background: rgba(248, 113, 113, 0.08);
    color: var(--error);
    font-size: 12.5px;
    flex-shrink: 0;
  }

  .results {
    flex: 1;
    min-height: 120px;
    overflow-y: auto;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .result {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border: 1px solid var(--border-0);
    border-radius: var(--radius);
    background: var(--bg-2);
  }

  .result:hover {
    border-color: var(--border-1);
  }

  .result-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .title {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-0);
    line-height: 1.35;
  }

  .meta {
    margin: 0;
    color: var(--text-1);
    font-size: 12px;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .meta em {
    font-style: normal;
    color: var(--text-2);
  }

  .doi {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .key {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--accent);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .insert-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 13px;
    border: 1px solid transparent;
    border-radius: var(--radius);
    background: var(--accent-strong);
    color: #fff;
    font-size: 12.5px;
    font-weight: 550;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .insert-btn:hover:not(:disabled) {
    filter: brightness(1.1);
  }

  .insert-btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 34px 16px;
    text-align: center;
    color: var(--text-1);
    font-size: 13px;
  }

  .state .hint {
    margin: 0;
    color: var(--text-2);
    font-size: 12px;
    max-width: 380px;
  }

  .state p {
    margin: 0;
  }

  .modal-foot {
    padding: 8px 12px;
    border-top: 1px solid var(--border-0);
    background: var(--bg-2);
    color: var(--text-2);
    font-size: 11.5px;
    flex-shrink: 0;
  }

  kbd {
    padding: 1px 5px;
    border: 1px solid var(--border-1);
    border-bottom-width: 2px;
    border-radius: 4px;
    background: var(--bg-3);
    font-family: var(--font-mono);
    font-size: 10.5px;
  }

  .spin {
    display: inline-grid;
    place-items: center;
    color: var(--accent);
    animation: spin 0.9s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
