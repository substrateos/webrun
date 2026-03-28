# Web Worker API Compatibility

`webrun` executes scripts in a standard [Web Worker](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API) environment. This document maps the complete [Web Worker API surface](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Functions_and_classes_available_to_workers) against what `webrun` currently supports.

## Reading this table

| Column | Meaning |
|---|---|
| **Status** | ✅ Supported · ❌ Not supported |
| **Permission** | Whether access requires a `webrun.json` config grant |

---

## WorkerGlobalScope Functions

| API | Status | Permission | Notes |
|---|---|---|---|
| [`atob()`](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/atob) / [`btoa()`](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/btoa) | ✅ | | |
| [`setTimeout()`](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/setTimeout) / [`clearTimeout()`](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/clearTimeout) | ✅ | | |
| [`setInterval()`](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/setInterval) / [`clearInterval()`](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/clearInterval) | ✅ | | |
| [`queueMicrotask()`](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/queueMicrotask) | ✅ | | |
| [`structuredClone()`](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/structuredClone) | ✅ | | |
| [`fetch()`](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/fetch) | ✅ | `permissions.network` | Domain allow-list. Localhost and private ranges are always blocked. |
| [`reportError()`](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/reportError) | ✅ | | |
| [`importScripts()`](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/importScripts) | ❌ | | Classic-mode only; use ESM `import` |
| [`createImageBitmap()`](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/createImageBitmap) | ❌ | | |
| [`postMessage()`](https://developer.mozilla.org/en-US/docs/Web/API/DedicatedWorkerGlobalScope/postMessage) | ✅ | | |
| [`requestAnimationFrame()`](https://developer.mozilla.org/en-US/docs/Web/API/DedicatedWorkerGlobalScope/requestAnimationFrame) / [`cancelAnimationFrame()`](https://developer.mozilla.org/en-US/docs/Web/API/DedicatedWorkerGlobalScope/cancelAnimationFrame) | ❌ | | Requires OffscreenCanvas |

---

## WorkerGlobalScope Properties

| API | Status | Permission | Notes |
|---|---|---|---|
| [`self`](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/self) | ✅ | | |
| [`location`](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/location) | ❌ | | |
| [`navigator`](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/navigator) | ✅ | | Partial — see Navigator section below |
| [`performance`](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/performance) | ✅ | | See Performance section below |
| [`crypto`](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/crypto) | ✅ | | Full Web Crypto |
| [`caches`](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/caches) | ❌ | | |
| [`crossOriginIsolated`](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/crossOriginIsolated) | ❌ | | |
| [`fonts`](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/fonts) | ❌ | | |
| [`indexedDB`](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/indexedDB) | ❌ | | |
| [`isSecureContext`](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/isSecureContext) | ❌ | | |
| [`origin`](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/origin) | ❌ | | |
| [`scheduler`](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/scheduler) | ❌ | | |
| [`trustedTypes`](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/trustedTypes) | ❌ | | |

---

## WorkerGlobalScope Events

| API | Status | Permission | Notes |
|---|---|---|---|
| [`error`](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/error_event) | ✅ | | |
| [`unhandledrejection`](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/unhandledrejection_event) | ✅ | | |
| [`rejectionhandled`](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/rejectionhandled_event) | ✅ | | |
| [`languagechange`](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/languagechange_event) | ❌ | | |
| [`online`](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/online_event) / [`offline`](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/offline_event) | ❌ | | |
| [`securitypolicyviolation`](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/securitypolicyviolation_event) | ❌ | | |

---

## WorkerNavigator

| API | Status | Permission | Notes |
|---|---|---|---|
| [`navigator.userAgent`](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/userAgent) | ✅ | | |
| [`navigator.language`](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/language) / [`navigator.languages`](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/languages) | ❌ | | |
| [`navigator.onLine`](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/onLine) | ❌ | | |
| [`navigator.hardwareConcurrency`](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/hardwareConcurrency) | ✅ | | |
| [`navigator.storage`](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/storage) | ✅ | | OPFS via `getDirectory()` |
| [`navigator.locks`](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/locks) | ❌ | | |
| [`navigator.permissions`](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/permissions) | ❌ | | |
| [`navigator.mediaCapabilities`](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/mediaCapabilities) | ❌ | | |
| [`navigator.connection`](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/connection) | ❌ | | Network Information API |
| [`navigator.gpu`](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/gpu) | ❌ | | WebGPU entry point |
| [`navigator.serial`](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/serial) | ❌ | | |
| [`navigator.hid`](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/hid) | ❌ | | |
| [`navigator.usb`](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/usb) | ❌ | | |

---

## Networking

| API | Status | Permission | Notes |
|---|---|---|---|
| [`fetch`](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API) / [`Request`](https://developer.mozilla.org/en-US/docs/Web/API/Request) / [`Response`](https://developer.mozilla.org/en-US/docs/Web/API/Response) / [`Headers`](https://developer.mozilla.org/en-US/docs/Web/API/Headers) | ✅ | `permissions.network` | |
| [`WebSocket`](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket) | ✅ | `permissions.network` | Same domain restrictions as `fetch` |
| [`XMLHttpRequest`](https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest) | ❌ | | |
| [`EventSource`](https://developer.mozilla.org/en-US/docs/Web/API/EventSource) | ❌ | | Server-Sent Events |

---

## Streams

| API | Status | Permission | Notes |
|---|---|---|---|
| [`ReadableStream`](https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream) / [`WritableStream`](https://developer.mozilla.org/en-US/docs/Web/API/WritableStream) / [`TransformStream`](https://developer.mozilla.org/en-US/docs/Web/API/TransformStream) | ✅ | | |
| [`ReadableStreamDefaultReader`](https://developer.mozilla.org/en-US/docs/Web/API/ReadableStreamDefaultReader) / [`ReadableStreamBYOBReader`](https://developer.mozilla.org/en-US/docs/Web/API/ReadableStreamBYOBReader) | ✅ | | |
| [`CompressionStream`](https://developer.mozilla.org/en-US/docs/Web/API/CompressionStream) / [`DecompressionStream`](https://developer.mozilla.org/en-US/docs/Web/API/DecompressionStream) | ✅ | | |
| [`TextEncoderStream`](https://developer.mozilla.org/en-US/docs/Web/API/TextEncoderStream) / [`TextDecoderStream`](https://developer.mozilla.org/en-US/docs/Web/API/TextDecoderStream) | ✅ | | |

---

## File System

| API | Status | Permission | Notes |
|---|---|---|---|
| [`FileSystemDirectoryHandle`](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemDirectoryHandle) | ✅ | `permissions.storage` | Via `ctx.dir`. Access is scoped per-path with `read` or `write` grants. |
| [`FileSystemFileHandle`](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle) | ✅ | `permissions.storage` | |
| [`FileSystemWritableFileStream`](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemWritableFileStream) | ✅ | `permissions.storage` | Requires `access: "write"` |
| [`navigator.storage.getDirectory()`](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/getDirectory) | ✅ | | Returns an ephemeral OPFS root scoped to this script run |
| [`navigator.storage.estimate()`](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/estimate) | ❌ | | |
| [`navigator.storage.persist()`](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist) / [`persisted()`](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persisted) | ❌ | | |

---

## File & Blob

| API | Status | Permission | Notes |
|---|---|---|---|
| [`Blob`](https://developer.mozilla.org/en-US/docs/Web/API/Blob) | ✅ | | |
| [`File`](https://developer.mozilla.org/en-US/docs/Web/API/File) | ✅ | | |
| [`FileReader`](https://developer.mozilla.org/en-US/docs/Web/API/FileReader) | ✅ | | |
| [`FileReaderSync`](https://developer.mozilla.org/en-US/docs/Web/API/FileReaderSync) | ❌ | | |
| [`FormData`](https://developer.mozilla.org/en-US/docs/Web/API/FormData) | ✅ | | |

---

## Encoding

| API | Status | Permission | Notes |
|---|---|---|---|
| [`TextEncoder`](https://developer.mozilla.org/en-US/docs/Web/API/TextEncoder) / [`TextDecoder`](https://developer.mozilla.org/en-US/docs/Web/API/TextDecoder) | ✅ | | |
| [`URL`](https://developer.mozilla.org/en-US/docs/Web/API/URL) / [`URLSearchParams`](https://developer.mozilla.org/en-US/docs/Web/API/URLSearchParams) | ✅ | | |
| [`URLPattern`](https://developer.mozilla.org/en-US/docs/Web/API/URLPattern) | ✅ | | |

---

## Cryptography

| API | Status | Permission | Notes |
|---|---|---|---|
| [`crypto.getRandomValues()`](https://developer.mozilla.org/en-US/docs/Web/API/Crypto/getRandomValues) | ✅ | | |
| [`crypto.randomUUID()`](https://developer.mozilla.org/en-US/docs/Web/API/Crypto/randomUUID) | ✅ | | |
| [`crypto.subtle`](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto) | ✅ | | Full SubtleCrypto |

---

## IndexedDB

| API | Status | Permission | Notes |
|---|---|---|---|
| [`indexedDB`](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API) / [`IDBFactory`](https://developer.mozilla.org/en-US/docs/Web/API/IDBFactory) | ❌ | | |
| [`IDBDatabase`](https://developer.mozilla.org/en-US/docs/Web/API/IDBDatabase) / [`IDBTransaction`](https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction) / [`IDBObjectStore`](https://developer.mozilla.org/en-US/docs/Web/API/IDBObjectStore) | ❌ | | |

---

## Cache API

| API | Status | Permission | Notes |
|---|---|---|---|
| [`caches`](https://developer.mozilla.org/en-US/docs/Web/API/CacheStorage) / [`CacheStorage`](https://developer.mozilla.org/en-US/docs/Web/API/CacheStorage) | ❌ | | |
| [`Cache`](https://developer.mozilla.org/en-US/docs/Web/API/Cache) | ❌ | | |

---

## Workers & Messaging

| API | Status | Permission | Notes |
|---|---|---|---|
| [`Worker`](https://developer.mozilla.org/en-US/docs/Web/API/Worker) | ✅ | | `type: "module"`. Child workers inherit the same security policy. |
| [`SharedWorker`](https://developer.mozilla.org/en-US/docs/Web/API/SharedWorker) | ❌ | | |
| [`MessageChannel`](https://developer.mozilla.org/en-US/docs/Web/API/MessageChannel) / [`MessagePort`](https://developer.mozilla.org/en-US/docs/Web/API/MessagePort) | ✅ | | |
| [`BroadcastChannel`](https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel) | ✅ | | |

---

## Concurrency

| API | Status | Permission | Notes |
|---|---|---|---|
| [`Atomics`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Atomics) | ✅ | | |
| [`SharedArrayBuffer`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer) | ✅ | | |

---

## Performance

| API | Status | Permission | Notes |
|---|---|---|---|
| [`performance.now()`](https://developer.mozilla.org/en-US/docs/Web/API/Performance/now) | ✅ | | |
| [`performance.mark()`](https://developer.mozilla.org/en-US/docs/Web/API/Performance/mark) / [`performance.measure()`](https://developer.mozilla.org/en-US/docs/Web/API/Performance/measure) | ✅ | | |
| [`performance.getEntries()`](https://developer.mozilla.org/en-US/docs/Web/API/Performance/getEntries) / [`getEntriesByName()`](https://developer.mozilla.org/en-US/docs/Web/API/Performance/getEntriesByName) / [`getEntriesByType()`](https://developer.mozilla.org/en-US/docs/Web/API/Performance/getEntriesByType) | ✅ | | |
| [`performance.memory`](https://developer.mozilla.org/en-US/docs/Web/API/Performance/memory) | ✅ | | `jsHeapSizeLimit` reflects configured `memoryMB` |
| [`performance.measureMemory()`](https://developer.mozilla.org/en-US/docs/Web/API/Performance/measureUserAgentSpecificMemory) | ✅ | | W3C spec `{ bytes, breakdown }` |
| [`PerformanceObserver`](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceObserver) | ✅ | | |

---

## Console

| API | Status | Permission | Notes |
|---|---|---|---|
| [`console.log`](https://developer.mozilla.org/en-US/docs/Web/API/console/log_static) / [`error`](https://developer.mozilla.org/en-US/docs/Web/API/console/error_static) / [`warn`](https://developer.mozilla.org/en-US/docs/Web/API/console/warn_static) / [`info`](https://developer.mozilla.org/en-US/docs/Web/API/console/info_static) / [`debug`](https://developer.mozilla.org/en-US/docs/Web/API/console/debug_static) | ✅ | | |
| [`console.table`](https://developer.mozilla.org/en-US/docs/Web/API/console/table_static) / [`console.group`](https://developer.mozilla.org/en-US/docs/Web/API/console/group_static) / [`console.time`](https://developer.mozilla.org/en-US/docs/Web/API/console/time_static) | ✅ | | |

---

## WebRTC

| API | Status | Permission | Notes |
|---|---|---|---|
| [`RTCPeerConnection`](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection) | ✅ | | Only local ICE candidates by default (no external STUN/TURN) |
| [`RTCDataChannel`](https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel) | ✅ | | |
| [`RTCSessionDescription`](https://developer.mozilla.org/en-US/docs/Web/API/RTCSessionDescription) | ✅ | | |
| [`MediaStream`](https://developer.mozilla.org/en-US/docs/Web/API/MediaStream) / [`MediaStreamTrack`](https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack) | ✅ | | Basic types; no device access |

---

## Canvas & Graphics

| API | Status | Permission | Notes |
|---|---|---|---|
| [`OffscreenCanvas`](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas) | ❌ | | |
| [`WebGLRenderingContext`](https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext) / [`WebGL2RenderingContext`](https://developer.mozilla.org/en-US/docs/Web/API/WebGL2RenderingContext) | ❌ | | |
| [`GPUDevice`](https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice) | ❌ | | WebGPU |
| [`ImageBitmap`](https://developer.mozilla.org/en-US/docs/Web/API/ImageBitmap) | ❌ | | |
| [`ImageData`](https://developer.mozilla.org/en-US/docs/Web/API/ImageData) | ❌ | | |

---

## WebAssembly

| API | Status | Permission | Notes |
|---|---|---|---|
| [`WebAssembly.compile`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/WebAssembly/compile) / [`instantiate`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/WebAssembly/instantiate) / [`instantiateStreaming`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/WebAssembly/instantiateStreaming) | ✅ | | |
| [`WebAssembly.Memory`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/WebAssembly/Memory) / [`Table`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/WebAssembly/Table) / [`Global`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/WebAssembly/Global) | ✅ | | |
| WASM threads | ✅ | | Via `SharedArrayBuffer` + `Atomics` |
| WASM SIMD | ✅ | | Depends on host CPU |

---

## WebCodecs

| API | Status | Permission | Notes |
|---|---|---|---|
| [`VideoEncoder`](https://developer.mozilla.org/en-US/docs/Web/API/VideoEncoder) / [`VideoDecoder`](https://developer.mozilla.org/en-US/docs/Web/API/VideoDecoder) | ❌ | | |
| [`AudioEncoder`](https://developer.mozilla.org/en-US/docs/Web/API/AudioEncoder) / [`AudioDecoder`](https://developer.mozilla.org/en-US/docs/Web/API/AudioDecoder) | ❌ | | |
| [`EncodedVideoChunk`](https://developer.mozilla.org/en-US/docs/Web/API/EncodedVideoChunk) / [`EncodedAudioChunk`](https://developer.mozilla.org/en-US/docs/Web/API/EncodedAudioChunk) | ❌ | | |

---

## Notifications

| API | Status | Permission | Notes |
|---|---|---|---|
| [`Notification`](https://developer.mozilla.org/en-US/docs/Web/API/Notification) | ❌ | | |

---

## Scheduler

| API | Status | Permission | Notes |
|---|---|---|---|
| [`scheduler.postTask()`](https://developer.mozilla.org/en-US/docs/Web/API/Scheduler/postTask) | ❌ | | Prioritized Task Scheduling API |
| [`scheduler.yield()`](https://developer.mozilla.org/en-US/docs/Web/API/Scheduler/yield) | ❌ | | |

---

## Web Locks

| API | Status | Permission | Notes |
|---|---|---|---|
| [`navigator.locks.request()`](https://developer.mozilla.org/en-US/docs/Web/API/LockManager/request) | ❌ | | |
| [`navigator.locks.query()`](https://developer.mozilla.org/en-US/docs/Web/API/LockManager/query) | ❌ | | |

---

## Permissions

| API | Status | Permission | Notes |
|---|---|---|---|
| [`navigator.permissions.query()`](https://developer.mozilla.org/en-US/docs/Web/API/Permissions/query) | ❌ | | |

---

## Fonts

| API | Status | Permission | Notes |
|---|---|---|---|
| [`FontFace`](https://developer.mozilla.org/en-US/docs/Web/API/FontFace) / [`FontFaceSet`](https://developer.mozilla.org/en-US/docs/Web/API/FontFaceSet) | ❌ | | CSS Font Loading API |

---

## Trusted Types

| API | Status | Permission | Notes |
|---|---|---|---|
| [`trustedTypes`](https://developer.mozilla.org/en-US/docs/Web/API/TrustedTypePolicyFactory) | ❌ | | |

---

## Device APIs

| API | Status | Permission | Notes |
|---|---|---|---|
| [`SerialPort`](https://developer.mozilla.org/en-US/docs/Web/API/SerialPort) | ❌ | | Web Serial |
| [`HIDDevice`](https://developer.mozilla.org/en-US/docs/Web/API/HIDDevice) | ❌ | | WebHID |
| [`USBDevice`](https://developer.mozilla.org/en-US/docs/Web/API/USBDevice) | ❌ | | WebUSB |

---

## Reporting

| API | Status | Permission | Notes |
|---|---|---|---|
| [`ReportingObserver`](https://developer.mozilla.org/en-US/docs/Web/API/ReportingObserver) | ❌ | | |

---

## Background APIs

| API | Status | Permission | Notes |
|---|---|---|---|
| [`BackgroundFetchManager`](https://developer.mozilla.org/en-US/docs/Web/API/BackgroundFetchManager) | ❌ | | |
| [`SyncManager`](https://developer.mozilla.org/en-US/docs/Web/API/SyncManager) | ❌ | | Background Synchronization |
| [`PeriodicSyncManager`](https://developer.mozilla.org/en-US/docs/Web/API/PeriodicSyncManager) | ❌ | | Web Periodic Background Sync |

---

## Other

| API | Status | Permission | Notes |
|---|---|---|---|
| [Barcode Detection API](https://developer.mozilla.org/en-US/docs/Web/API/Barcode_Detection_API) | ❌ | | |
| [Compute Pressure API](https://developer.mozilla.org/en-US/docs/Web/API/Compute_Pressure_API) | ❌ | | |
| [Content Index API](https://developer.mozilla.org/en-US/docs/Web/API/Content_Index_API) | ❌ | | |
| [Cookie Store API](https://developer.mozilla.org/en-US/docs/Web/API/Cookie_Store_API) | ❌ | | |
| [Idle Detection API](https://developer.mozilla.org/en-US/docs/Web/API/Idle_Detection_API) | ❌ | | |
| [Media Capabilities API](https://developer.mozilla.org/en-US/docs/Web/API/Media_Capabilities_API) | ❌ | | |
| [Media Source Extensions](https://developer.mozilla.org/en-US/docs/Web/API/Media_Source_Extensions_API) | ❌ | | |
| [Network Information API](https://developer.mozilla.org/en-US/docs/Web/API/Network_Information_API) | ❌ | | |
| [Payment Handler API](https://developer.mozilla.org/en-US/docs/Web/API/Payment_Handler_API) | ❌ | | |
| [Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API) | ❌ | | |
| [Service Worker API](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API) | ❌ | | |
| [User-Agent Client Hints](https://developer.mozilla.org/en-US/docs/Web/API/User-Agent_Client_Hints_API) | ❌ | | |

---

## Modules

| API | Status | Permission | Notes |
|---|---|---|---|
| ESM `import` (static) | ✅ | | |
| ESM [`import()`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/import) (dynamic) | ✅ | | |
| [Import maps](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/script/type/importmap) | ✅ | | Via `importMap` in `webrun.json`. Hierarchically merged across configs. |
| [`import.meta.url`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/import.meta) | ✅ | | |

---

## Resource Limits

These are sandbox-specific constraints not defined by the Web Worker spec, configured via `webrun.json`:

| Limit | Config Key | Behaviour |
|---|---|---|
| Execution timeout | `limits.timeoutMillis` | Script is forcibly terminated on expiry |
| Memory ceiling | `limits.memoryMB` | Process exits with code 137 on breach |
| Network domains | `permissions.network` | Requests outside the allow-list are rejected |
| Filesystem access | `permissions.storage` | Read/write enforced per declared path |
| Environment variables | `permissions.env` | Only declared vars visible via `ctx.env` |
