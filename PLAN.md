# Gnome-Desktop — Desktop Icons for GNOME 50

Desktop file icons for GNOME Shell 50 on Fedora 44 (Wayland), built as a GTK4
helper application plus a thin shell extension, with full cross-application
drag-and-drop and file operations delegated to Nautilus.

## 0. Status — next up

**M0 done.** Repo skeleton, extension, helper, IPC, Makefile and lint config
all written and running. `make check` parses every source file; the helper runs
standalone (`make helper`) and exits cleanly on EOF.

**M0.5 done — every question answered PASS.** Measured in a nested devkit shell
(`gnome-shell --devkit --wayland`, a real compositor with a real seat) with the
probe in `spike/`:

1. `set_type(DESKTOP)` on a Wayland window — **PASS**. Bottom of the stack
   below a normal toplevel, `onAllWorkspaces=true`, absent from the alt-tab
   list, `skipTaskbar=true`, and `move_resize_frame()` gives the window the
   **full monitor**, 1280x800+0+0, not the 1280x768 work area.
2. Pointer input to a transparent bottom window — **PASS**. Full sequence
   received by the GTK client: `pointer-entered`, raw button press,
   `pointer-pressed {button:1, nPress:1, x:400, y:700}`, raw release, and
   `pointer-left` when the pointer moved onto the window above. Routing is
   correct in both directions — a click on the normal window does not leak
   through to the desktop.
3. Wallpaper shows through — **PASS**. The stage screenshot shows the
   wallpaper, the transparent window's outline over it edge to edge, and a
   normal window above both.
4. Bonus, since M4 depends on it: **keyboard works**. Clicking the desktop
   moves focus to the DESKTOP window, and a synthesised keypress arrives as
   `key-pressed {"key":"a"}`.

Nothing is left blocking the architecture. `spike/` and its two references in
`extension.js` can go.

**A headless shell cannot answer input questions.** An earlier run under
`--headless --virtual-monitor` reported the window clamped to the work area,
lost pointer clicks entirely, and read `warp_pointer()` back with one axis
zeroed. All three were artefacts of the headless backend; none reproduced under
`--devkit`. Use headless for logic and screenshots only.

**M1 done.** The probe is gone; the shell-process half is complete and verified
in a devkit shell:

- enable → helper spawned, window adopted and placed; disable → window released,
  helper killed, zero stray processes; re-enable → clean, `State: ACTIVE`, no
  errors. `kill -9` on the helper → detected, window released, restarted after
  the 1s backoff, window re-adopted.
- `workareas-changed` fires on every maximise, so `MonitorTracker` compares
  snapshots and stays quiet when nothing the helper cares about moved. Without
  that, every maximise would resize every desktop window.
- Shell state (overview open/closed) is published over IPC. `showing-desktop` is
  *not*: Mutter still has the signal but there is no getter and nothing in a
  stock GNOME 50 session ever sets it.
- Two permanent dev tools replace the throwaway probe, both off unless asked
  for: `GNOME_DESKTOP_ICONS_DEBUG=1` traces lifecycle to the journal, and
  `GNOME_DESKTOP_ICONS_DEBUG_SHOT=<path>` writes a screenshot of the stage — the
  only way to see a nested shell, since the Screenshot D-Bus method refuses
  every caller but the shell's own UI.
- `make lint` is clean against the flat ESLint config; `make check` parses every
  file.

**M2, M3 and most of M4 done** — the desktop draws real files and its menus
work. Verified in a nested devkit shell against a `~/Desktop` holding 29 items
across 25 content types (video, audio, images, SVG, PDF, font, archives, 3D
models, code, a symlink, a launcher):

- Icons come from `Gio.FileInfo.get_icon()`, so every type resolves through the
  shared MIME database and the active icon theme with no table of our own.
- Thumbnails render for video, JPEG/PNG/WebP/GIF, SVG, PDF and TTF, generated
  through `GnomeDesktop.DesktopThumbnailFactory` and written back to
  `~/.cache/thumbnails` for Files to reuse.
- The item menu is built per click from the selection: it names the real default
  application ("Open with Image Viewer"), offers a terminal on folders, "Set as
  Background" on pictures, and "Allow Launching" on an untrusted `.desktop`.
- Nautilus operations proven end to end over D-Bus: CreateFolder, TrashURIs and
  **Undo restoring the trashed folder** — the shared undo stack works.
- `~/Desktop` and the drawn desktop stay in step in both directions, via
  `Gio.FileMonitor`.

**IPC moved off stdout.** The demo caught a real defect: an `f3d` thumbnailer
spawned for the 3D models inherited the helper's fd 1 and printed to it, injecting
`VTK window class type is …` into the middle of the protocol. Every application
the user opens from the desktop would do the same. IPC is now line-delimited JSON
over a Unix socket in `XDG_RUNTIME_DIR` (mode 0700), with the peer's pid checked
on connect. The helper's stdio is inherited from the shell, so its diagnostics and
its children's noise land in the journal where they belong. §3.2 rewritten.

**Environment note.** GIO file monitors fail with "Unable to find default local
file monitor type" when the kernel's inotify instance limit is exhausted — this
machine had 135 instances against a limit of 128. Raised at runtime with
`sudo sysctl -w fs.inotify.max_user_instances=1024`. The helper now treats a
missing monitor as loss of live updates rather than a fatal error.

**M5 done, and renamed.** The extension is now *Gnome Desktop Icons*,
uuid `gnome-desktop-icons@ned.tabulov.gmail.com`, by Shahab Nedaei.

- Drag out offers `text/uri-list`, `x-special/gnome-copied-files` and plain
  text. Drop in accepts files, text and images; the last two are written into
  ~/Desktop as new files.
- Icon positions persist in `metadata::nautilus-icon-position` as global logical
  coordinates, which encodes both where an icon is and which monitor it is on.
  A position belonging to a monitor that is gone fails the bounds test and the
  icon falls back to automatic placement.
- Cut/copy/paste share the clipboard formats Files uses, so the copy/cut intent
  survives between the two.

Three bugs found while building it:

1. **A drag source on the icon never fires.** The view's click gesture claims
   the button press first, which cancels the child's gesture before it reaches
   GTK's drag threshold. Both controllers now live on the view, which hit-tests
   in `prepare`; GTK then arbitrates properly — click wins a tap, drag wins a
   pull.
2. **A metadata write is not a file change.** The directory monitor never fires
   for it, so after a drop the view has to re-lay-out itself; waiting for the
   model meant the icon snapped back.
3. **Multi-monitor layout used global coordinates** for a widget whose own
   coordinates are monitor-local, so everything on a second monitor would have
   been laid out past the right-hand edge of the world.

**Two things to know before uploading to extensions.gnome.org.**

`shexli`, the official pre-upload analyzer, reports **EGO-P-007**: "Some
JavaScript files are not reachable from `extension.js` or `prefs.js` imports" —
every file under `helper/`. That is correct and unavoidable: the helper is
spawned as a subprocess, not imported. It needs an explanation in the review
notes, not a fix.

`shexli` 0.2.1 also **segfaults** on the full tree (a crash inside its
tree-sitter parser, reproducible by adding `src/windowLayering.js` to a tree
that already has the other shell-process files). Our sources parse cleanly under
`node --check`, ESLint and GJS itself, so this is a bug in the tool. Worth
re-checking against a newer shexli before uploading, in case the server-side
check trips over the same thing.

**Resume here:** inline rename, rubber-band selection, the Home/Trash/volume
items, and `prefs.js`.

## 1. Verified environment

Runtime-checked on this machine, not assumed.

| Component | Version | Notes |
|---|---|---|
| Fedora | 44 | |
| GNOME Shell | 50.4 | ESM extensions, `Extension` base class |
| Mutter | 18 | `Meta-18`, `Mtk-18`, `Clutter-18` typelibs |
| GJS | 1.88.1 | |
| Session | Wayland | shell cannot be restarted; dev happens in a devkit shell |
| Nautilus | 50.2.2 | D-Bus activatable |
| gnome-desktop4 | 44.5 | `GnomeDesktop-4.0` → thumbnail factory |
| GTK | 4.x | `GdkWayland-4.0`, `GdkX11-4.0` both introspectable |

**D-Bus surface** (introspected here):

- `org.gnome.Nautilus.FileOperations2` at `/org/gnome/Nautilus/FileOperations2`
  — `CopyURIs`, `MoveURIs`, `TrashURIs`, `DeleteURIs`, `EmptyTrash`,
  `CreateFolder`, `RenameURI`, `Undo`, `Redo`
- `org.freedesktop.FileManager1` at `/org/freedesktop/FileManager1`
  — `ShowItems`, `ShowFolders`, `ShowItemProperties`

**Meta APIs** (confirmed present via GJS against `Meta-18.typelib`):

- `Meta.Window.set_type()` — added in Shell 49
- `Meta.Window.hide_from_window_list()` / `show_in_window_list()` — added in 49
- `Meta.WindowType.DESKTOP` = 1
- `stick()`, `move_resize_frame()`, `make_above()`

**Confirmed absent / dead ends:**

- DING is not packaged in Fedora 44 — no conflict
- Mutter does not implement `wlr-layer-shell` — that route is closed
- `gnome-shell --nested` no longer exists on Shell 50; the flag is `--devkit`

## 2. Framing

Nautilus dropped desktop rendering in GNOME 3.28 and no Nautilus process can
paint the desktop. Nautilus is therefore a **file-operations backend**, not a
renderer. That still delivers the "everything connected" goal: its progress
windows, conflict dialogs, Properties dialog, and a shared undo stack.

Icons and thumbnails are genuine GNOME assets — `Gio.FileInfo.get_icon()`
resolves through the active GTK icon theme, and thumbnails live in
`~/.cache/thumbnails`, the shared spec cache Nautilus already populates.

## 3. Architecture

Two processes. Nearly all logic lives in the helper, an ordinary GTK4
application; the extension stays small and holds the only version-fragile code.

```
┌─ gnome-shell process ───────────────────────────────┐
│  extension.js                                       │
│    HelperProcess    spawn, supervise, restart       │
│    MonitorTracker   geometry + workarea + scale     │
│    WindowLayering   set_type + hide_from_window_list│
└──────────────── stdin/stdout JSON lines ────────────┘
                          │
┌─ desktop-helper (GTK4, GJS) ────────────────────────┐
│  one transparent Gtk.Window per monitor             │
│  FileModel     Gio enumerate + FileMonitor + volumes│
│  IconView      Gtk.Widget grid, icons, thumbnails   │
│  Interaction   select, keyboard, menus, rename      │
│  DragAndDrop   Gdk.ContentProvider / Gtk.DropTarget │
│  NautilusOps  ──D-Bus──▶ Nautilus                   │
└─────────────────────────────────────────────────────┘
```

**Why the split is not optional.** The review guidelines forbid importing `Gtk`,
`Gdk`, or `Adw` into the shell process at all. Since we want GTK rendering, GTK
menus, and GTK drag-and-drop, they must live in a separate process. The split
also means file enumeration, thumbnailing, and rendering sit somewhere that can
crash and restart harmlessly — a crash in shell-process code ends the session,
and synchronous I/O there freezes the compositor.

### 3.1 Layering — resolved

The helper's windows must sit below every normal window, above the wallpaper, on
all workspaces, and be excluded from alt-tab and the overview.

**Mechanism: native Wayland helper + `Meta.Window.set_type()`.**

The extension identifies the helper's windows and calls:

```js
metaWindow.set_type(Meta.WindowType.DESKTOP);
metaWindow.hide_from_window_list();
```

Mutter then handles desktop windows natively — bottom of the stack, present on
all workspaces, excluded from alt-tab — and `hide_from_window_list()` is the
supported way to keep it out of the window list rather than a monkey-patch.

Geometry stays the extension's job: a Wayland client cannot position itself, so
the extension pushes monitor geometry over IPC and applies it server-side with
`move_resize_frame()`. The extension is part of the compositor, so it can move a
window the client itself is not permitted to move.

**Approaches now discarded**, recorded so they are not revisited:

- XWayland + `_NET_WM_WINDOW_TYPE_DESKTOP` on the raw XID — unnecessary now that
  `set_type()` exists, and it would drag in an XWayland dependency
- XWayland + manual re-stacking (the DING approach) — same, plus more code
- `Object.defineProperty(metaWindow, 'skip_taskbar', …)` — superseded by
  `hide_from_window_list()`
- `wlr-layer-shell` — not implemented by Mutter

This removes the project's single largest risk. Reference implementation still
worth reading for interaction details: `gitlab.com/rastersoft/desktop-icons-ng`
— consult, do not vendor.

### 3.2 IPC

Line-delimited JSON over a **private Unix socket** in `XDG_RUNTIME_DIR`. Small
surface: monitor geometry, scale factors, overview state, settings changes,
lifecycle. The helper independently owns a session-bus connection for talking to
Nautilus.

The first implementation used the child's stdin/stdout, chosen over a private
D-Bus socket to avoid bus-name races. That was wrong, and M2 proved it: the
helper spawns grandchildren it does not control — every external thumbnailer,
and every application the user opens from the desktop. They inherit fd 1 and
some of them print to it. An `f3d` thumbnailer invoked for a `.stl` wrote
`VTK window class type is …` straight into the protocol stream.

A socket has none of that exposure and none of D-Bus's name races. It is created
by the extension before the spawn, the path is passed as `--socket`, and the
extension checks the connecting peer's pid before accepting. `XDG_RUNTIME_DIR`
is mode 0700, so no other user can reach the socket, and the pid check stops
another process of the same user from driving the desktop. Helper stdio is
inherited from the shell, so diagnostics go to the journal.

Note on the guideline "prefer D-Bus over spawning subprocesses": that rule
targets shelling out to system commands and bundling binaries. Our helper is our
own GJS script — the guidelines explicitly say helper scripts should be written
in GJS — it is unprivileged, and it is the only way to get GTK out of the shell
process. Worth a comment in the source explaining exactly this.

## 4. Conformance with GNOME guidelines

Rules from the review guidelines and best-practices pages that shape the build:

**Lifecycle**
- Create nothing before `enable()` — no `Gio.Settings`, no widgets at module scope
- `disable()` reverses everything: destroy widgets and null them, disconnect
  every stored handler id, remove every GLib source via `GLib.Source.remove()`
  even when the callback would return `false`, clear Maps
- Keep `enable()` and `disable()` adjacent in the class so cleanup is verifiable
- `destroy()` order: remove sources → disconnect signals → release children →
  `super.destroy()` last
- Override `destroy()` rather than connecting to the `destroy` signal
- No `_destroyed` boolean guards; null the instance instead
- Be ready for `disable()` at any time

**Process boundaries**
- Never import `Gtk`/`Gdk`/`Adw` in the shell process
- Never import `Clutter`/`Meta`/`St`/`Shell` in `prefs.js`
- Shared utility modules may import neither

**Forbidden**
- Deprecated `ByteArray`, `Lang`, `Mainloop`
- Bundled binaries or shared libraries; obfuscated or minified code
- Telemetry
- `run_dispose()` without documented cause

**metadata.json**
- Required: `uuid`, `name`, `description`, `shell-version`, `url`
- `shell-version`: `["50"]` only — stable releases plus at most one dev release
- **Drop `session-modes`** — the guidelines say omit it when only `user` mode is
  used, so my earlier draft was wrong to include it
- Schema id must be based on `org.gnome.shell.extensions`
- Schema file named `<schema-id>.gschema.xml`
- Id used is `org.gnome.shell.extensions.gnome-desktop-icons`, not the plain
  `…extensions.desktop` this plan first sketched. GSettings ids are global, and
  `desktop` is too likely to collide with another extension
- UUID: `gnome-desktop-icons@ned.tabulov.gmail.com`
- No `gnome.org` namespace in the UUID

**Code style**
- Modular files with single responsibilities; small entry point
- No defensive `?.()` or `typeof x === 'function'` checks on guaranteed APIs;
  target Shell 50 specifically rather than writing multi-version compatibility
- No redundant try/catch around `destroy()`, `disconnect()`, `GLib.Source.remove()`
- `this.getSettings()` with no argument, relying on `settings-schema`

**Shell 49/50 API notes**
- `Meta.Rectangle` removed → `Mtk.Rectangle`
- `Clutter.ClickAction` / `TapAction` removed → `Clutter.ClickGesture` /
  `Clutter.LongPressGesture`
- `Meta.Window.get_maximized()` removed → `is_maximized()`
- New in 50: `GLib.idle_add_once()`, `GLib.timeout_add_once()`,
  `GLib.timeout_add_seconds_once()`, `actor.easeAsync()`

**Licensing:** GPL-2.0-or-later.

**Breakage strategy:** prefer stable platform libraries (GLib, GObject, Gio,
Clutter, Mutter, St) over Shell internals. Our design already leans this way —
`set_type()` and `move_resize_frame()` are Mutter API, not Shell internals.

## 5. Milestones

### M0 — Repo skeleton and dev loop
- `metadata.json` per §4 (no `session-modes`, `url` present, `shell-version: ["50"]`)
- ESM `extension.js` extending `Extension` with adjacent `enable()`/`disable()`
- Helper skeleton: GTK4 `Adw.Application` in GJS, launched via `Gio.Subprocess`
  with stdin/stdout pipes
- `Makefile`: `install` symlinks into `~/.local/share/gnome-shell/extensions/`,
  `schemas` runs `glib-compile-schemas`
- ESLint with the GJS/GNOME config

**Dev loop** — the shell cannot be restarted on Wayland, and a running shell
will not pick up a newly installed extension, so all iteration happens in a
throwaway shell with its own bus and its own config:

```bash
# Nested, with a window you can click in. Needs: sudo dnf install mutter-devkit
export DBUS_SESSION_BUS_ADDRESS=$(dbus-daemon --session --fork --print-address)
XDG_CONFIG_HOME=$T/config XDG_CACHE_HOME=$T/cache GSETTINGS_BACKEND=keyfile \
  gnome-shell --devkit --wayland --wayland-display=probe-wl

# Headless, for automated runs. No input, but the probe can screenshot.
gnome-shell --headless --virtual-monitor 1280x800 --wayland

journalctl --user -f                                # logs (live session only)
SHELL_DEBUG=all G_MESSAGES_DEBUG=all                # stack traces
# Alt+F2 → lg   for Looking Glass (evaluator, actors, extension errors)
gnome-shell-test-tool --extension <uuid.zip> <script>   # wants a packed zip
```

Which extensions load is controlled by `enabled-extensions` in
`$XDG_CONFIG_HOME/glib-2.0/settings/keyfile` under `GSETTINGS_BACKEND=keyfile`,
which keeps the throwaway shell from loading the real session's extensions.

Two traps met while setting this up. `gnome-shell --wayland` on its own no
longer nests — it tries to take the seat and dies with `EBUSY`; `--devkit` is
the only nested mode. And never reach for `pkill -f gnome-shell`: the pattern
matches the shell running the command, which then kills itself. Write the pid
to a file at launch and kill that.

### M0.5 — Layering smoke test — done
Throwaway code in `spike/`, wired in from `extension.js` by two lines. All
questions answered PASS; see §0. First job in M1 is to delete `spike/`, the two
lines in `extension.js`, and the probe widgets in `helper/desktopWindow.js`
along with the outline rule in `data/helper.css`.

### M1 — Extension: lifecycle, geometry, layering — done
- ✅ Spawn and supervise the helper; restart with backoff; kill cleanly on `disable()`
- ✅ Track `Main.layoutManager.monitors`, `monitors-changed`, workarea and
  scale-factor changes; push geometry over IPC, skipping no-op republishes
- ✅ Apply `set_type()` + `hide_from_window_list()` on helper windows
- ✅ Confine every Shell-internal (as opposed to Mutter) API touch to
  `src/shellCompat.js`, which hands back disconnect thunks so `disable()` never
  has to remember which object owns a handler id
- ✅ Publish overview state for M2 to consume

### M2 — Helper: windows and grid
- One transparent `Gtk.Window` per monitor, sized from IPC geometry
- CSS transparent background so the shell wallpaper shows through
- Grid layout: cell size from icon-size setting, column/row flow, stable slot
  allocator, RTL
- Behaviour on overview enter/leave and show-desktop

### M3 — Helper: file model and rendering
- Async `enumerate_children_async` on `~/Desktop` with
  `standard::*,thumbnail::*,metadata::*,access::*,time::modified,trash::*`
- `Gio.FileMonitor` for live changes; `Gio.VolumeMonitor` for drives
- Special items: Home, Trash (`trash:///` with count), mounted volumes, each
  toggleable
- Position persistence via the `metadata::nautilus-icon-position` file attribute
- Icons from `fileInfo.get_icon()`; thumbnails from `thumbnail::path`, missing
  ones generated with `GnomeDesktop.DesktopThumbnailFactory`
- Emblems: symlink, unreadable, untrusted launcher
- `.desktop` files via `Gio.DesktopAppInfo.new_from_filename`, honouring the
  trusted/executable check before launching

### M4 — Helper: interaction
- Click policy from `org.gnome.nautilus.preferences click-policy`
  (currently `double` here) so the desktop matches Files
- Ctrl/Shift multi-select, rubber-band marquee
- Keyboard: arrows, Home/End, Enter, F2, Delete, Ctrl+A, type-ahead
- Item menu: Open, Open With…, Cut, Copy, Rename, Move to Trash, Delete,
  Show in Files, Properties
- Background menu: New Folder, New Document (`~/Templates`), Paste, Select All,
  Sort By, Change Background, Display Settings
- Inline rename
- Accessibility: the guide has a dedicated page; icons need accessible names and
  keyboard reachability

### M5 — Drag and drop (the reason for this architecture)
- Intra-desktop: reposition icons, drop onto folders
- Desktop → external: `Gdk.ContentProvider` offering `text/uri-list` and
  `x-special/gnome-copied-files`; test into Files, Firefox upload dialogs, GIMP,
  a terminal
- External → desktop: `Gtk.DropTarget` for the same, plus dropped text and
  images creating files
- Modifier semantics: copy vs move vs link with correct cursor feedback
- Clipboard interop with the same targets so Cut/Copy/Paste works both
  directions with Nautilus

### M6 — Nautilus integration
- `NautilusOps`: async proxy over `FileOperations2` for Copy, Move, Trash,
  Delete, CreateFolder, Rename, Undo, Redo, with a Gio fallback
- `FileManager1.ShowItems` for "Show in Files"; `ShowItemProperties` for the
  Properties dialog, so we build none of our own
- Trash icon reflects empty/full; Empty Trash routed through Nautilus

### M7 — Preferences, polish, packaging
- `prefs.js` with `ExtensionPreferences.fillPreferencesWindow()` + Adw
  (no St/Clutter/Meta imports)
- GSettings schema: icon size, show hidden, Home/Trash/volumes toggles, sort
  mode, keep-arranged, click-policy override
- Translations: `gettext-domain`, `locale/`
- Multi-monitor hotplug, primary-monitor change, mixed DPI, fractional scaling
- `gnome-extensions pack`

## 6. Risk register

| Risk | Mitigation |
|---|---|
| ~~`set_type(DESKTOP)` semantics on Wayland unverified~~ | Closed in M0.5: stacking, workspaces, alt-tab, geometry all behave |
| ~~Transparent bottom-stacked window may not take input~~ | Closed in M0.5: pointer and keyboard both arrive |
| Headless test runs give false negatives | Real behaviour only under `--devkit`; headless is for logic and screenshots |
| Shell internals drift between releases | Prefer Mutter/platform API; confine Shell internals to `shellCompat.js` |
| Helper crash loop | Supervised restart with backoff; extension survives without it |
| Cleanup mistakes failing review | `enable()`/`disable()` adjacent; store every handler id and source id |
| Two-process complexity | Helper is a standalone GTK4 app, runnable and debuggable outside the shell |

## 7. Layout

```
Gnome-Desktop/
  metadata.json
  extension.js               small entry point only
  prefs.js                   Adw only, no St/Clutter/Meta      (M7)
  Makefile
  eslint.config.js
  package.json               lint tooling only, no runtime deps
  schemas/org.gnome.shell.extensions.gnome-desktop-icons.gschema.xml
  src/                       shell process
    helperProcess.js         lifecycle + IPC
    monitorTracker.js        geometry
    windowLayering.js        set_type, hide_from_window_list, move_resize_frame
    shellState.js            overview state
    shellCompat.js           ALL Shell-internal API
    debug.js                 opt-in tracing
    debugCapture.js          opt-in stage screenshot
  helper/                    separate GTK4 process
    main.js                  Adw.Application entry point
    desktopWindow.js         per-monitor transparent window
    iconView.js              grid, selection, keyboard, menus
    desktopIcon.js           one icon widget
    itemMenu.js              context menu built per selection
    fileModel.js             Gio enumerate, monitor, volumes
    thumbnails.js            GnomeDesktop.DesktopThumbnailFactory
    terminal.js              "Open in Terminal"
    dragAndDrop.js           content providers / drop targets      (M5)
    nautilusOps.js           D-Bus to Nautilus
    promisify.js             Gio._promisify registrations
    ipc.js                   JSON lines over the private socket
  data/
    helper.css
  locale/
```
