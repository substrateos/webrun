# File System

OPFS-compatible file system implementation for WebRun.

## Why

WebRun sandboxes run web-standard code that expects browser storage APIs — the
[Origin Private File System](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)
(OPFS). This module implements the full OPFS surface
(`FileSystemDirectoryHandle`, `FileSystemFileHandle`,
`FileSystemWritableFileStream`, `FileSystemSyncAccessHandle`) backed by a
real file system provided by the host.

The implementation is platform-agnostic. All file I/O is injected via
`FSRuntime` — an interface that maps closely to Deno's FS API but can be
implemented by any platform that supports basic file operations.

## Architecture

```
                ┌──────────────────────────────┐
  Web app uses  │  FileSystemDirectoryHandle   │  Standard OPFS API
                │  FileSystemFileHandle        │
                │  FileSystemWritableFileStream │
                │  FileSystemSyncAccessHandle  │
                └──────────────┬───────────────┘
                               │ calls
                ┌──────────────▼───────────────┐
                │         FSRuntime            │  Injected interface
                │  stat, readFile, writeFile,  │
                │  open, openSync, mkdir, ...  │
                └──────────────┬───────────────┘
                               │ implemented by
                ┌──────────────▼───────────────┐
                │   deno/file_system/mod.ts    │  Deno.stat, Deno.open, ...
                └──────────────────────────────┘
```

## Files

| File | Role |
|---|---|
| `types.ts` | `FSRuntime`, `AsyncFileHandle`, `SyncFileHandle` — injection contract |
| `deno/file_system/mod.ts` | `createFS(rt)` — OPFS classes closing over injected Deno runtime |
