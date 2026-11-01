<script lang="ts">
  /**
   * FileTree.svelte — flat-rendered project tree derived from the normalized
   * file cache. Directories toggle open/closed; text files open in the
   * editor; binary files are listed (they feed the compiler) but grayed out.
   */
  import { filePaths, files, activeFilePath } from '../fileSystem';
  import { ChevronRight, FileText, Folder, FolderOpen } from 'lucide-svelte';

  interface Row {
    name: string;
    path: string;
    depth: number;
    kind: 'dir' | 'file';
    isBinary: boolean;
    dirty: boolean;
  }

  /** Collapsed directory paths. Replaced wholesale on toggle for reactivity. */
  let collapsed = $state<Set<string>>(new Set());

  function buildRows(paths: string[], fileMap: Map<string, { isBinary: boolean; dirty: boolean }>): Row[] {
    const rows: Row[] = [];

    const walk = (prefix: string, depth: number): void => {
      const dirs = new Map<string, string[]>();
      const fileNames: { name: string; path: string }[] = [];

      for (const p of paths) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) {
          fileNames.push({ name: rest, path: p });
        } else {
          const dir = rest.slice(0, slash);
          if (!dirs.has(dir)) dirs.set(dir, []);
          dirs.get(dir)!.push(p);
        }
      }

      for (const dir of [...dirs.keys()].sort((a, b) => a.localeCompare(b))) {
        const path = prefix + dir;
        const isOpen = !collapsed.has(path);
        rows.push({ name: dir, path, depth, kind: 'dir', isBinary: false, dirty: false });
        if (isOpen) walk(prefix + dir + '/', depth + 1);
      }

      for (const f of fileNames.sort((a, b) => a.name.localeCompare(b.name))) {
        const meta = fileMap.get(f.path);
        rows.push({
          name: f.name,
          path: f.path,
          depth,
          kind: 'file',
          isBinary: meta?.isBinary ?? false,
          dirty: meta?.dirty ?? false,
        });
      }
    };

    walk('', 0);
    return rows;
  }

  const rows = $derived(buildRows($filePaths, $files));

  function toggleDir(path: string): void {
    const next = new Set(collapsed);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    collapsed = next;
  }

  function openFile(row: Row): void {
    if (row.kind === 'file' && !row.isBinary) activeFilePath.set(row.path);
  }
</script>

<div class="file-tree" role="tree" aria-label="Project files">
  <div class="tree-header">Files</div>
  <div class="tree-body">
    {#each rows as row (row.path)}
      {#if row.kind === 'dir'}
        <button
          class="row dir"
          style="padding-left: {8 + row.depth * 14}px"
          role="treeitem"
          aria-expanded={!collapsed.has(row.path)}
          aria-selected="false"
          onclick={() => toggleDir(row.path)}
        >
          <ChevronRight size={13} class={'chev' + (!collapsed.has(row.path) ? ' open' : '')} />
          {#if collapsed.has(row.path)}
            <Folder size={14} />
          {:else}
            <FolderOpen size={14} />
          {/if}
          <span class="name">{row.name}</span>
        </button>
      {:else}
        <button
          class="row file"
          class:active={row.path === $activeFilePath}
          class:binary={row.isBinary}
          style="padding-left: {8 + row.depth * 14 + 16}px"
          role="treeitem"
          aria-selected={row.path === $activeFilePath}
          title={row.isBinary ? `${row.path} (binary — used by the compiler, not editable)` : row.path}
          onclick={() => openFile(row)}
        >
          <FileText size={14} />
          <span class="name">{row.name}</span>
          {#if row.dirty}<span class="dot" title="Unsaved changes"></span>{/if}
        </button>
      {/if}
    {:else}
      <div class="empty">No project files</div>
    {/each}
  </div>
</div>

<style>
  .file-tree {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-width: 0;
    background: var(--bg-1);
  }

  .tree-header {
    display: flex;
    align-items: center;
    height: 34px;
    padding: 0 12px;
    border-bottom: 1px solid var(--border-0);
    background: var(--bg-2);
    color: var(--text-2);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    flex-shrink: 0;
  }

  .tree-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 6px 0;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    height: 27px;
    padding-right: 8px;
    font-size: 12.5px;
    color: var(--text-1);
    text-align: left;
    white-space: nowrap;
    border-radius: 4px;
  }

  .row:hover {
    background: var(--bg-2);
    color: var(--text-0);
  }

  .row.dir {
    color: var(--text-1);
  }

  .row.file.active {
    background: var(--accent-dim);
    color: var(--accent);
  }

  .row.binary {
    color: var(--text-2);
    font-style: italic;
  }

  /* :global because the class lands on the lucide component's svg. */
  .row.dir :global(.chev) {
    transition: transform 120ms ease;
    color: var(--text-2);
    flex-shrink: 0;
  }

  .row.dir :global(.chev.open) {
    transform: rotate(90deg);
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--warning);
    flex-shrink: 0;
    margin-left: auto;
  }

  .empty {
    padding: 12px;
    color: var(--text-2);
    font-size: 12.5px;
  }
</style>
