# Submitting to extensions.gnome.org

Build the package, then upload
`gnome-desktop-icons@ned.tabulov.gmail.com.shell-extension.zip`.

```bash
make pot     # only if the strings changed
make pack
```

## Note to paste into the reviewer comment box

> This extension draws the desktop with a GTK4 helper process, not inside
> gnome-shell. Two review points follow from that.
>
> **1. It spawns a subprocess.** `src/helperProcess.js` runs
> `gjs -m helper/main.js`. The guideline against spawning aims at shell commands
> and bundled binaries. This is our own unprivileged GJS script, which the
> guidelines endorse. It is also the only way to obey the rule that keeps GTK out
> of the shell process, because the desktop needs GTK rendering, GTK menus and
> real GTK drag sources. Those drag sources are the reason for the whole design.
> They let the user drag a file from the desktop into another application.
> `extension.js` never imports anything under `helper/`.
>
> **2. shexli reports EGO-P-007** for every file under `helper/`: "some
> JavaScript files are not reachable from extension.js or prefs.js imports".
> That report is correct, and we cannot fix it. Those files are the helper
> process, and `gjs` loads them, not the shell. `extension.js` reaches
> everything under `src/` in the normal way.
>
> The shell-process half imports no GTK. `prefs.js` imports no Clutter, Meta, St
> or Shell. `enable()` and `disable()` sit next to each other in `extension.js`,
> and `disable()` reverses everything. It stops the helper, unlinks the socket,
> disconnects every handler through the thunks that `src/shellCompat.js` returns,
> and removes every GLib source.

## Audited against the review guidelines

Four points came out of a line-by-line read of the guidelines. Two of them were
MUSTs that this extension broke.

**The description now declares clipboard access.** The rule: "Extensions that
access the clipboard, with or without user interaction, MUST declare it in the
description." Cut, Copy and Paste access it. The clipboard data goes nowhere
except the clipboard.

**"Run as Administrator" is gone.** The rule: "Spawning privileged subprocesses
should be avoided at all costs. If absolutely necessary, the subprocess MUST be
run with `pkexec` and MUST NOT be an executable or script that can be modified
by a user process." A script on the user's own desktop fails the second
condition, whatever launches it. No version of that menu item can pass. "Run in
Terminal" stays, and it runs as the user. The terminal opens in the file's
folder, and `sudo` is one word away if the user wants it.

**The extension now asks the helper to exit instead of killing it.** The rule:
"Processes MUST be spawned carefully and exit cleanly." `disable()` used
`force_exit()`, which sends SIGKILL. It now drops the socket, which is the
helper's cue to quit, and follows with SIGTERM.

**The package holds no .po or .pot file.** The guidelines name those as
unnecessary files. `--podir` compiles them into one .mo file, and the sources
stay in the repository.

One judgement call is worth naming to a reviewer. The rule: "An extension MUST
NOT ship with default keyboard shortcuts for interacting with clipboard data."
This extension handles Ctrl+C, Ctrl+X and Ctrl+V, but only as ordinary key
events on the desktop widget while that widget has focus, the same as any text
entry. It registers nothing with the shell's keybinding system, and no shortcut
works while another window has focus. If a reviewer reads the rule more
strictly, the handlers can go, and the menus stay as they are.

## Checklist

- [x] `metadata.json`: uuid, name, description, `shell-version: ["50"]`, url,
      `settings-schema`, `gettext-domain`. No `session-modes`, because this
      extension uses user mode only.
- [x] The UUID uses no `gnome.org` namespace.
- [x] The schema id is based on `org.gnome.shell.extensions`, and the file name
      matches the id.
- [x] GPL-2.0-or-later, with an SPDX tag and a copyright line on every source
      file.
- [x] No `ByteArray`, `Lang` or `Mainloop`. No bundled binaries. No telemetry.
- [x] `make lint` is clean. `make check` parses every file as an ES module.
- [x] Verified from the built package: unzip it, run
      `glib-compile-schemas schemas/`, then load it in a nested shell. Also
      verified in German with `LANGUAGE=de`.
- [x] The description declares clipboard access.
- [x] No privileged subprocess of any kind.
- [x] The spawned helper exits on EOF, then on SIGTERM. Never SIGKILL.
- [x] The package holds no .po or .pot file, no build scripts and no
      screenshots.
- [x] Logging stays off until you set `GNOME_DESKTOP_ICONS_DEBUG=1`. Nothing
      logs once per item.

## On AI assistance

The guidelines allow AI "as a learning aid or a development tool", but they
expect the submitter to "be able to justify and explain the code they submit".
Claude wrote this codebase. Every decision that is not obvious carries a comment
with its reasoning in the source: why the process is split, why the two halves
talk over a socket and not stdout, why the drag source sits on the view, and why
"Run as Administrator" is absent. Read through those comments before you answer
a reviewer's question.

## Known tool problem

`shexli` 0.2.1 **segfaults** on this package. The crash is in the tool, not in
the extension. It is partly nondeterministic, and removing any one of several
unrelated source files avoids it. Every file parses cleanly under `node
--check`, under ESLint and under GJS itself. Check again with a newer shexli
before you upload. If the server-side check fails the same way, this is the
explanation.
