# Submitting to extensions.gnome.org

Build the package and upload `gnome-desktop-icons@ned.tabulov.gmail.com.shell-extension.zip`:

```bash
make pot     # only if strings changed
make pack
```

## Note to paste into the reviewer comment box

> This extension draws the desktop with a GTK4 helper process rather than
> inside gnome-shell. Two review points follow from that, both deliberate:
>
> **1. It spawns a subprocess.** `src/helperProcess.js` runs
> `gjs -m helper/main.js`. The guideline against spawning targets shelling out
> to system commands and bundling binaries; this is our own unprivileged GJS
> script, which the guidelines endorse. It is also the only way to satisfy the
> rule that GTK must never be imported into the shell process, because the
> desktop needs GTK rendering, GTK menus and — the reason for the whole design —
> real GTK drag sources, so files can be dragged from the desktop into other
> applications. Nothing under `helper/` is ever imported by `extension.js`.
>
> **2. shexli reports EGO-P-007** — "some JavaScript files are not reachable
> from extension.js or prefs.js imports" — for every file under `helper/`. That
> is correct and cannot be fixed: those files are the helper process, loaded by
> `gjs`, not by the shell. Everything under `src/` is reachable from
> `extension.js` in the normal way.
>
> The shell-process half imports no GTK; `prefs.js` imports no Clutter, Meta,
> St or Shell. `enable()` and `disable()` are adjacent in `extension.js` and
> `disable()` reverses everything: the helper is killed, its socket unlinked,
> every handler disconnected through the thunks `src/shellCompat.js` hands back,
> and every GLib source removed.

## Checklist

- [x] `metadata.json`: uuid, name, description, `shell-version: ["50"]`, url,
      `settings-schema`, `gettext-domain`. No `session-modes` — user mode only.
- [x] UUID contains no `gnome.org` namespace.
- [x] Schema id is based on `org.gnome.shell.extensions`, and the file is named
      after it.
- [x] GPL-2.0-or-later, with the SPDX tag and a copyright line on every source.
- [x] No `ByteArray`, `Lang` or `Mainloop`; no bundled binaries; no telemetry.
- [x] `make lint` clean; `make check` parses every file as an ES module.
- [x] Verified from the built package: unzip, `glib-compile-schemas schemas/`,
      load in a nested shell. Also verified in German (`LANGUAGE=de`).

## Known tool problem

`shexli` 0.2.1 **segfaults** on this package. The crash is in the tool, not the
extension: it is partly nondeterministic, removing any one of several unrelated
source files avoids it, and every file parses cleanly under `node --check`,
ESLint and GJS itself. Re-check with a newer shexli before uploading; if the
server-side check trips over the same thing, this is the explanation.
