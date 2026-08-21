# Webrun Permission Model

## Identity

Webrun behaves like a web browser, but on the command line and for pure JavaScript code. The browser loads a page from any URL, then limits what capabilities it has. Webrun loads a script from the filesystem or a URL, then limits what capabilities it has.

## Threat Model

Three threats drive the permission design:

| Threat | Attack Vector | Mitigation |
|---|---|---|
| **Exfiltration** | Read local files + send to remote server | Don't grant local reads AND network simultaneously by default |
| **Corruption** | Write to user files (overwrite .bashrc, inject code) | Default to read-only; writes only to tempdirs |
| **Privilege escalation** | Modify scripts/configs to run with elevated permissions | No write to real paths by default |

> [!IMPORTANT]
> Read-only local access is safe **only in isolation**. The safety also depends on the invoker's capabilities. If the invoker (parent process with access to stdio, exit status, etc.) has write access or network access, a child with local reads can pass data back via stdout, enabling indirect exfiltration through the parent. The threat model must consider the full call chain, not just the immediate process.

**Full local read access** and **full network access** (including `tcp`) are each safe in isolation. Local write access is NOT safe even in isolation (corruption risk). The intersection of local reads + network is the most dangerous combination, requiring explicit consent via webrun.json.

## webrun.json

`webrun.json` is an **end-user consideration**, not a code consideration. It is written by the person running the code, not the code's author. It grants permissions to the code being run — analogous to user-granted browser permissions (filesystem access, camera access, bluetooth access), not to CSP headers or manifest files.

The **`permissions` field** within webrun.json activates the permission regime. Other webrun.json features (aliases, locations, limits, bindings) are orthogonal and work independently. A webrun.json without a `permissions` field does not restrict capabilities — safe entrypoint-based defaults still apply.

### The `locations` Field

A **location** in webrun is analogous to the browser URL bar and `window.location` — it identifies the **entrypoint**, not a storage path. Just as a browser's location determines which page is loaded and what security context applies, a webrun location determines which code is run and what permissions it has.

A location key can be a specific file or a directory. A directory location applies to any entrypoint that is an exact match or is (possibly deeply) nested within that directory.

The `locations` field in webrun.json allows a user to declare entrypoint-specific permission sets:

```json
{
  "locations": {
    "./tools/build/": {
      "permissions": {
        "storage": { "../../dist": { "access": "write" } },
        "network": ["registry.npmjs.org"]
      }
    }
  }
}
```

When a location key is a **local path**, read access to that path should be implicit — otherwise the location entry is unusable (you can't load the code you're granting permissions to). This is infrastructure, not a permission grant: you declared intent to run code from this location, so the code must be loadable.

`locations` is the **sole mechanism** for path-based permission grants. Ceiling enforcement comes naturally from the parent's own permissions — a child can never exceed what the parent has. For per-invocation narrowing (e.g., dynamic child paths like tempdirs), `options.permissions` in ctx.run allows the parent code to request specific permissions, validated against the parent's ceiling by the runtime.

## Entrypoint-Based Defaults (No `permissions`)

When no `permissions` field is present in any discovered webrun.json (or no webrun.json exists at all), the entrypoint determines which axis of access is safe to grant by default:

### Local entrypoint (`webrun ./script.js`)

| Capability | Default |
|---|---|
| Local file reads | ✓ read-only (scoped — see open questions) |
| Local imports | ✓ (local files only) |
| Tempdir writes | ✓ (ephemeral, safe) |
| Local file writes | ✗ |
| Network (fetch, WebSocket) | ✗ |
| URL imports | ✗ |

Safe because: the script can read but can't exfiltrate (no network), can't corrupt (read-only), can't escalate (no writes). No more dangerous than `cat`.

### Remote entrypoint (`webrun https://example.com/script.js`)

| Capability | Default |
|---|---|
| Local file reads | ✗ |
| Local imports | ✗ |
| Tempdir writes | ✓ (ephemeral, safe) |
| Local file writes | ✗ |
| Network (fetch, WebSocket) | ✓ (broader than same-origin) |
| URL imports | ✓ |

Safe because: the script can talk to the network but can't read local files — nothing to exfiltrate.

## With `permissions`

When a `permissions` field is present in a discovered webrun.json, **all filesystem access — including local imports — is governed by declared permissions.** The user has opted into the permission regime. Only explicitly declared capabilities are available.

| Capability | Behavior |
|---|---|
| Local file reads | Per declared storage read paths |
| Local imports | Per declared storage read paths |
| Tempdir writes | ✓ (always available) |
| Local file writes | Per declared storage write paths |
| Network (fetch) | Per declared network hosts |
| URL imports | Per declared import hosts |
| Direct Sockets (`tcp`) | `true` if explicit tcp permission granted |
| WebGPU (`gpu`) | `true` if explicit gpu permission granted |
| WebRTC (`webrtc`) | `true` if explicit webrtc permission granted |
| Spawn children (`run`) | `true` if explicit run permission granted |
| OS binary prefixes (`binaries`) | Per declared prefixes, e.g. `[["git", "rev-list"]]` or `[["/usr/bin/git"]]`. Bare commands (without `/`) are resolved against the host's original `PATH` at sandbox setup time. |
| Expose URL paths (`createFileSystemHandleURL`) | `true` if explicit createFileSystemHandleURL permission granted |

Local path entries in `locations` implicitly grant read access to their own directory — a location you can't read is unusable.

## Principles

**P1: The `permissions` field activates the permission regime.** Its presence in any discovered webrun.json switches from entrypoint-based defaults to explicit grants. Without it, safe defaults apply regardless of what other webrun.json fields exist. This keeps features like aliases, locations, limits, and bindings orthogonal to the security model.

**P2: ctx.dir is caller-driven.**
- **CLI**: requires `--dir` (non-empty) AND storage read permission. `--dir` without read permission is a configuration error.
- **ctx.run**: provided when the parent passes `options.dir`. No storage check — the parent is trusted to decide.

**P3: Local imports follow storage reads when `permissions` is present.** With a `permissions` field, only paths with declared read access are importable. Without `permissions`, imports follow entrypoint-based defaults.

**P4: Storage is non-cascading.** Each config in the chain gets only the storage it explicitly declares. Parent storage is the parent's own capability, never inherited by the child.

**P5: Contradictory configurations are errors.** `--dir` pointing at a directory without read permission fails loudly rather than silently degrading.

**P6: ctx.run ceilings are maintained regardless of `permissions` presence.** A parent constrains the child's capabilities. The child cannot exceed the parent's ceiling even if the child has no `permissions` field.

**P7: Entrypoint determines the default permission axis.** A local entrypoint grants local reads (no network). A remote entrypoint grants network access (no local reads). This ensures the two dangerous axes are never simultaneously granted by default.

## Invocation Behavior Matrix

| # | Config | Invocation | Local imports | ctx.dir | Storage ops | Network |
|---|---|---|---|---|---|---|
| 1 | No `permissions` | CLI, --dir given | ✓ read-only for dir | ✓ read-only | ✗ read-only (no writes) | ✗ |
| 2 | No `permissions` | CLI, no --dir, local entry | ✓ permissive (scope TBD) | ✗ | ✗ | ✗ |
| 3 | No `permissions` | ctx.run + options.dir | ✓ permissive (scoped to dir) | ✓ (caller gave dir) | ✗ | ✗ |
| 4 | No `permissions` | ctx.run, no options.dir | ✓ entry script only | ✗ | ✗ | ✗ |
| 5 | `permissions` with read storage | CLI, --dir | ✓ per declared paths | ✓ | ✓ per declared paths | Per config |
| 6 | `permissions` with read storage | ctx.run + options.dir | ✓ per declared paths | ✓ | ✓ per declared paths | Per config |
| 7 | `permissions`, NO read storage | CLI, --dir | Error (--dir without read permission) | — | — | — |
| 8 | `permissions`, NO read storage | ctx.run + options.dir | ✗ (opted in, no read) | ✓ (caller gave dir, handle is inert) | ✗ | Per config |
| 9 | `permissions` | CLI, --dir="" | ✗ (opted in, no read scope) | ✗ (explicitly opted out) | ✗ | Per config |

## Testing Boundaries

Two distinct invocation contexts exist, and they cannot fully simulate each other:

### CLI-only testable
- **Entrypoint-based defaults** — no ceiling, no parent, no permission regime
- **`--dir` error cases** (row 7)
- **`--dir=""` opt-out** (row 9)
- **The "no config" scenario** — no ceiling, no parent

### Worker (ctx.run) testable
- **Nested child behavior** — ceiling enforcement, options.dir → ctx.dir
- **Storage non-cascading** (P4)
- **With-config permission enforcement** — storage read/write, network, imports
- **Location-based permissions** — entrypoint-specific permission sets
- **Independent subprocess spawning** — ctx.run without options.dir (row 4)

### Not testable via ctx.run
The entrypoint-based default behavior (P7) cannot be tested via ctx.run because ctx.run always implies a **parent ceiling** (P6). The "bare CLI, no ceiling" scenario only exists at the top-level CLI boundary.

## Open Questions

- **Row 2 scope**: `webrun script.js` may need both cwd-scoped reads AND entry-script-directory-scoped reads (they may differ).
- **Row 3 imports**: when ctx.run provides options.dir with no webrun.json, import scoping is unclear.
- **Locations implicit read**: should the implicit read access for local location paths be the location's directory, or just the entry script file itself?
- **Invoker chain safety**: how should the threat model account for a parent with network access spawning a child with local reads? The child can exfiltrate via stdout → parent → network.
