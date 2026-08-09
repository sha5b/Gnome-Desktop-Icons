# Gnome Desktop Icons

File icons on the desktop for GNOME Shell 50. Nautilus does the file operations.

Nautilus stopped drawing the desktop in GNOME 3.28, and no Nautilus process can
paint it today. This extension draws the desktop itself. It does not reimplement
the file manager behind it. Copy, move, trash, rename and create-folder all go to
Nautilus over D-Bus, so you get its progress windows, its conflict dialogs, its
Properties window, and one undo stack shared with Files. Press Ctrl+Z in Files,
and it undoes what you just did on the desktop.

![The desktop, with icons and thumbnails for a folder of mixed files](docs/screenshot-desktop.png)

## What it does

- Shows everything in `~/Desktop`, and updates as the folder changes
- Takes icons from the shared MIME database and the active icon theme, so every
  file type looks the way it does in Files
- Makes thumbnails for images, video, SVG, PDF, fonts and anything else with a
  thumbnailer installed, and writes them back to `~/.cache/thumbnails` for Files
  and every other GNOME application to use
- Builds the context menu from what you click. The first entry names the
  application that opens the file. Folders offer a terminal, pictures offer to
  become the wallpaper, and an untrusted launcher offers to be trusted
- Shows Home, the wastebasket (empty or full) and mounted drives. You can switch
  off each one
- Remembers where you drag an icon, for each file and each monitor. You can drag
  files out to any application, and drop files, text or images in
- Selects with a rectangle you sweep over empty desktop, or with a few letters
  that you type
- Renames with F2, and runs scripts in a terminal
- Lists every application registered for the type in Open With, and every other
  installed application under it. One switch makes the choice permanent
- Cuts, copies and pastes in the formats Files uses, and shares its undo stack
- Selects with click, Ctrl-click and Ctrl+A. Arrow keys, Enter and Delete work

The menus are short on purpose. Nothing appears in them that a keyboard shortcut
already covers, and nothing appears twice.

## Requirements

| | |
|---|---|
| GNOME Shell | 50 |
| Session | Wayland or X11 |
| Nautilus | optional. Trash and new folder fall back to plain GIO without it |

## Install

```bash
make install        # symlink this checkout into ~/.local/share/gnome-shell/extensions
make schemas        # compile the GSettings schema
```

Then log out and log in again. A running shell scans the extension directories
only at startup, so it cannot load a new extension into the session you are
already in.

```bash
gnome-extensions enable gnome-desktop-icons@ned.tabulov.gmail.com
```

## How it is built

Two processes:

```
gnome-shell process          desktop-helper (GTK4, GJS)
  extension.js                 one transparent window per monitor
  helperProcess.js  <-------->  iconView.js     grid, selection
  monitorTracker.js   socket    menus.js        the menus, keyboard.js the keys
  windowLayering.js             fileModel.js    Gio enumerate + monitor
  shellCompat.js                thumbnails.js   shared thumbnail cache
                                nautilusOps.js  --D-Bus--> Nautilus
```

The split is not optional. Extension review forbids GTK in the shell process,
and cross-application drag-and-drop needs real GTK drag sources. The separate
process also keeps file enumeration and thumbnailing off the compositor, and it
makes a crash survivable. The extension restarts the helper with a backoff.

The helper's windows are ordinary Wayland toplevels. The extension turns them
into desktop windows with `Meta.Window.set_type(DESKTOP)` and
`hide_from_window_list()`, both added in Shell 49. It then places them with
`move_resize_frame()`, because a Wayland client cannot place itself.

The two processes speak line-delimited JSON over a Unix socket in
`XDG_RUNTIME_DIR`, not over the child's stdout. Thumbnailers and launched
applications inherit fd 1, and some of them print to it. One chatty thumbnailer
corrupts a protocol that lives there.

## Development

You cannot restart the shell on Wayland, so all work happens in a nested shell
with its own bus and its own configuration.

```bash
sudo dnf install mutter-devkit    # --devkit is the only nested mode on Shell 50

make run            # nested shell, nothing installed
make run DEBUG=1    # the same, with lifecycle tracing
```

`make run` builds a throwaway profile. The profile holds its own
`XDG_DATA_HOME` with a symlink to this checkout, its own settings and its own
session bus. The command starts a nested shell against that profile, then
deletes the profile on exit. It never touches your real `~/.local/share` or your
real extension list, so it is also the safe way to try the extension before you
install it.

Three environment variables help. All of them stay silent until you set them.

| Variable | Effect |
|---|---|
| `GNOME_DESKTOP_ICONS_DEBUG=1` | traces lifecycle, geometry and layering to the journal |
| `GNOME_DESKTOP_ICONS_DEBUG_SHOT=<path>` | closes the overview and writes a screenshot of the stage |
| `GNOME_DESKTOP_ICONS_DEBUG_CLICK=x,y[,button]` | clicks that spot first |
| `GNOME_DESKTOP_ICONS_DEBUG_DRAG=x1,y1,x2,y2` | drags between those points first |

The last three exist because a nested shell has no session bus that a test
script can drive, and its pointer belongs to the outer compositor. Without them
you cannot see or touch the thing you are building.

```bash
make check     # parse every source file as an ES module
make lint      # eslint, after npm install
make helper    # run the helper alone, in one ordinary window
make pot       # refresh the translation template
make pack      # build the zip for extensions.gnome.org
```

One note about file monitors. GIO monitors fail with `Unable to find default
local file monitor type` when the kernel runs out of inotify instances, which a
few editors and sync clients manage on their own. The desktop still lists files.
It stops updating live.

```bash
sudo sysctl -w fs.inotify.max_user_instances=1024
```

## Status

These work: the grid, icons, thumbnails, selection with rubber-band and
type-ahead, the keyboard, context menus, the Nautilus operations, drag-and-drop,
the clipboard, saved icon positions, Home, the wastebasket, volumes, rename,
running scripts, and preferences.

German translation included. `make pot` refreshes the template, and a new
language needs one `locale/xx.po` file.

Not verified yet: rubber-band and drag-out with a real mouse. `SUBMISSION.md`
holds the extensions.gnome.org checklist.

## Author

Shahab Nedaei <ned.tabulov@gmail.com>

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).
