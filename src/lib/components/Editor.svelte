<script lang="ts">
  /**
   * Editor.svelte — the application's single CodeMirror 6 instance.
   *
   * - LaTeX syntax highlighting via the legacy `stex` stream mode.
   * - `Mod-s` (Ctrl/Cmd+S) saves the active file to disk and recompiles.
   * - Switching `activeFilePath` swaps the document *in place* — the view is
   *   never remounted, and per-file `EditorState`s (undo history, cursor,
   *   selection) are preserved per project session.
   * - The view instance is published to the shared `editorView` store
   *   (architectural rule #1) so external modules can read/dispatch it.
   * - Every keystroke syncs the buffer into the normalized file cache, so
   *   the compiler (and future LLM context builders) always see live content.
   */
  import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor, rectangularSelection, crosshairCursor } from '@codemirror/view';
  import { EditorState } from '@codemirror/state';
  import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
  import { bracketMatching, indentUnit, StreamLanguage, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
  import { tags as t } from '@lezer/highlight';
  import { stex } from '@codemirror/legacy-modes/mode/stex';
  import { FileText } from 'lucide-svelte';

  import { files, activeFilePath, directoryHandle, updateFileContent } from '../fileSystem';
  import { saveAndCompile } from '../compiler';
  import { editorView } from '../editorState';

  let host: HTMLDivElement;
  let view: EditorView | null = null;

  /** Editor states per open file — keeps undo history across file switches. */
  const docStates = new Map<string, EditorState>();

  /** Guards the update listener while we swap documents programmatically. */
  let swapping = false;

  /** Path whose content the editor currently displays. */
  let currentPath: string | null = null;

  const editorTheme = EditorView.theme(
    {
      '&': {
        height: '100%',
        backgroundColor: 'transparent',
        color: 'var(--text-0)',
        fontSize: '13.5px',
      },
      '.cm-scroller': {
        fontFamily: 'var(--font-mono)',
        lineHeight: '1.65',
        paddingTop: '8px',
      },
      '&.cm-focused': { outline: 'none' },
      '.cm-content': { caretColor: 'var(--accent)' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
      '.cm-gutters': {
        backgroundColor: 'transparent',
        color: 'var(--text-2)',
        border: 'none',
        borderRight: '1px solid var(--border-0)',
        paddingLeft: '6px',
      },
      '.cm-activeLine': { backgroundColor: 'rgba(110, 168, 254, 0.055)' },
      '.cm-activeLineGutter': { backgroundColor: 'rgba(110, 168, 254, 0.10)', color: 'var(--text-0)' },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
        backgroundColor: 'rgba(110, 168, 254, 0.22)',
      },
      '.cm-searchMatch': { backgroundColor: 'rgba(251, 191, 36, 0.25)' },
    },
    { dark: true },
  );

  /** Quiet dark palette for the tokens the stex stream mode emits. */
  const latexHighlight = HighlightStyle.define([
    { tag: t.comment, color: '#66718a', fontStyle: 'italic' },
    { tag: t.keyword, color: '#c792ea' },
    { tag: t.string, color: '#9ece8f' },
    { tag: t.number, color: '#f5a97f' },
    { tag: t.atom, color: '#f5a97f' },
    { tag: t.variableName, color: '#82aaff' },
    { tag: t.tagName, color: '#7fdbca' },
    { tag: t.meta, color: '#66718a' },
    { tag: t.operator, color: '#89ddff' },
    { tag: t.bracket, color: '#aeb7c7' },
    { tag: t.invalid, color: '#f87171' },
  ]);

  const extensions = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    crosshairCursor(),
    bracketMatching(),
    indentUnit.of('    '),
    StreamLanguage.define(stex),
    syntaxHighlighting(latexHighlight),
    editorTheme,
    keymap.of([
      {
        key: 'Mod-s',
        preventDefault: true,
        run: () => {
          void saveAndCompile();
          return true;
        },
      },
      ...defaultKeymap,
      ...historyKeymap,
      indentWithTab,
    ]),
    EditorView.updateListener.of((update) => {
      if (swapping || !update.docChanged || !currentPath) return;
      updateFileContent(currentPath, update.state.doc.toString());
    }),
  ];

  function stateFor(content: string): EditorState {
    return EditorState.create({ doc: content, extensions });
  }

  /** Swap the visible document without unmounting the view. */
  function swapTo(path: string | null, content: string): void {
    if (!view) return;
    // Never save when switching TO "no file": during a project re-open the
    // reconcile effect runs with path=null before the scan finishes, and
    // saving then would re-pollute docStates (already cleared by the
    // directory-change effect) with the previous project's buffer — which
    // would resurrect stale content the next time a same-named file opens.
    if (path !== null && currentPath && currentPath !== path && view.state.doc.toString() !== '') {
      docStates.set(currentPath, view.state);
    }
    currentPath = path;
    swapping = true;
    try {
      view.setState(path === null ? stateFor('') : (docStates.get(path) ?? stateFor(content)));
    } finally {
      swapping = false;
    }
  }

  // Create the view once. Listed before the reconciliation effect so it is
  // guaranteed to exist when that effect first runs.
  $effect(() => {
    view = new EditorView({ parent: host, state: stateFor('') });
    editorView.set(view);
    return () => {
      editorView.set(null);
      view?.destroy();
      view = null;
      docStates.clear();
      currentPath = null;
    };
  });

  // A new project invalidates cached editor states (paths may repeat).
  $effect(() => {
    void $directoryHandle;
    docStates.clear();
  });

  // Reconcile the visible document with the active file / cache contents.
  $effect(() => {
    const path = $activeFilePath;
    const map = $files;
    if (!view) return;

    const record = path ? map.get(path) : null;
    if (!path || !record || record.isBinary) {
      if (currentPath !== null) swapTo(null, '');
      return;
    }
    const content = record.content as string;
    if (path !== currentPath) {
      swapTo(path, content);
    } else if (view.state.doc.toString() !== content) {
      // Same path, new content → the cache was replaced externally
      // (project re-scan). Fresh state so history matches the new content.
      docStates.delete(path);
      swapTo(path, content);
    }
  });

  const record = $derived($activeFilePath ? $files.get($activeFilePath) : undefined);
</script>

<div class="editor-pane">
  <div class="tab-bar">
    {#if record && !record.isBinary}
      <FileText size={13} />
      <span class="tab-path">{record.path}</span>
      {#if record.dirty}<span class="dirty-dot" title="Unsaved changes"></span>{/if}
    {:else if record}
      <FileText size={13} />
      <span class="tab-path">{record.path}</span>
      <span class="tab-note">binary — not editable</span>
    {:else}
      <span class="tab-note">No file open</span>
    {/if}
  </div>

  <div class="cm-host" bind:this={host}></div>

  {#if !record || record.isBinary}
    <div class="overlay-note">
      {#if record}
        <p><strong>{record.path}</strong> is a binary file.</p>
        <p class="muted">It is sent to the compiler as raw bytes, but cannot be edited here.</p>
      {:else}
        <p class="muted">Select a file from the tree to start editing.</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .editor-pane {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
    min-width: 0;
    background: var(--bg-1);
  }

  .tab-bar {
    display: flex;
    align-items: center;
    gap: 7px;
    height: 34px;
    padding: 0 12px;
    border-bottom: 1px solid var(--border-0);
    background: var(--bg-2);
    color: var(--text-1);
    font-size: 12.5px;
    flex-shrink: 0;
  }

  .tab-path {
    font-family: var(--font-mono);
    color: var(--text-0);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .tab-note {
    color: var(--text-2);
  }

  .dirty-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--warning);
    flex-shrink: 0;
  }

  .cm-host {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .cm-host :global(.cm-editor) {
    height: 100%;
  }

  .overlay-note {
    position: absolute;
    inset: 40px 0 0 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    text-align: center;
    pointer-events: none;
    color: var(--text-1);
  }

  .muted {
    color: var(--text-2);
    font-size: 12.5px;
  }
</style>
