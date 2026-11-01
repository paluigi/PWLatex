/**
 * Ambient type declarations for the parts of the File System Access API that
 * TypeScript's `lib.dom.d.ts` does not cover yet (the directory picker on
 * `Window`, the async `entries()` iterator, and the permission queries).
 *
 * These augment — not replace — the built-in `FileSystem*Handle` types.
 */

interface Window {
  /** Opens the native directory picker. Desktop Chromium only. */
  showDirectoryPicker?: (options?: {
    id?: string;
    mode?: 'read' | 'readwrite';
    startIn?: string;
  }) => Promise<FileSystemDirectoryHandle>;
}

interface FileSystemDirectoryHandle {
  /** Yields `[name, handle]` pairs for every entry in the directory. */
  entries(): AsyncIterableIterator<[string, FileSystemFileHandle | FileSystemDirectoryHandle]>;
  /** Not implemented in all browsers — always treat as optional. */
  queryPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  /** Must be called from a user gesture; not implemented in all browsers. */
  requestPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}
