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

## Audited against the review guidelines

Four things came out of reading the guidelines line by line rather than from
memory. Two were MUSTs we were breaking.

**Clipboard use is now declared in the description.** "Extensions that access
the clipboard, with or without user interaction, **MUST** declare it in the
description." Cut, Copy and Paste do. Clipboard data goes nowhere but the
clipboard.

**"Run as Administrator" is gone.** "Spawning privileged subprocesses should be
avoided at all costs. If absolutely necessary, the subprocess **MUST** be run
with `pkexec` and **MUST NOT** be an executable or script that can be modified
by a user process." A script sitting on the user's own desktop fails the second
condition however it is launched, so no implementation of that menu item could
pass. "Run in Terminal" stays, unprivileged; typing `sudo` in the terminal it
opens is one word and is the user's decision.

**The helper is now asked to exit, not killed.** "Processes **MUST** be spawned
carefully and exit cleanly." `disable()` used `force_exit()`, which is SIGKILL.
It now drops the socket — the helper's cue to quit — and follows with SIGTERM.

**No .po or .pot in the package.** The guidelines name them as unnecessary
files. `--podir` compiles them to a single .mo; the sources stay in the repo.

One judgement call worth naming to a reviewer: "An extension **MUST NOT** ship
with default keyboard shortcuts for interacting with clipboard data." Ctrl+C,
Ctrl+X and Ctrl+V are handled, but only as ordinary key events on the desktop
widget while it has focus — the same as in any text entry. Nothing is registered
with the shell's keybinding system, and no shortcut works while another window
is focused. If a reviewer reads the rule more strictly than that, the handlers
can go without affecting the menus.

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
- [x] Clipboard access declared in the description.
- [x] No privileged subprocess of any kind.
- [x] Spawned helper exits on EOF, then SIGTERM; never SIGKILL.
- [x] Package holds no .po/.pot, no build scripts, no screenshots.
- [x] Logging is off unless `GNOME_DESKTOP_ICONS_DEBUG=1`; nothing logs per item.

## On AI assistance

The guidelines allow AI "as a learning aid or a development tool" but expect the
submitter to "be able to justify and explain the code they submit". This
codebase was written with Claude. Every non-obvious decision is commented with
its reasoning in the source — why the process is split, why IPC is a socket and
not stdout, why the drag source sits on the view, why "Run as Administrator" is
absent — so the explanations are in the code rather than only in someone's head.
Worth reading through before answering a reviewer's question.

## Known tool problem

`shexli` 0.2.1 **segfaults** on this package. The crash is in the tool, not the
extension: it is partly nondeterministic, removing any one of several unrelated
source files avoids it, and every file parses cleanly under `node --check`,
ESLint and GJS itself. Re-check with a newer shexli before uploading; if the
server-side check trips over the same thing, this is the explanation.
