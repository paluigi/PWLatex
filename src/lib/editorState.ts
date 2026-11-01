/**
 * editorState.ts
 *
 * ARCHITECTURAL RULE #1 — "Expose the Editor View".
 *
 * The single CodeMirror `EditorView` instance of the application lives in
 * this shared store. External modules — future AI completion providers,
 * reference/bibliography insert tools, SyncTeX click-to-source, tests — can
 * read cursor/selection state and dispatch transactions without reaching into
 * the Editor component:
 *
 * ```ts
 * import { get } from 'svelte/store';
 * import { editorView } from '$lib/editorState';
 *
 * const view = get(editorView);
 * view?.dispatch({ changes: { from: view.state.selection.main.head, insert: '\\cite{…}' } });
 * ```
 */

import { writable } from 'svelte/store';
import type { EditorView } from '@codemirror/view';

/** The application's live CodeMirror view, or null before/after mount. */
export const editorView = writable<EditorView | null>(null);
