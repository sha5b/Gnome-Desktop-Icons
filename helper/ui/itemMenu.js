// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright 2026 Shahab Nedaei <ned.tabulov@gmail.com>
//
// Builds the item context menu for whatever is actually selected.
//
// Files does not show one fixed menu. Right-clicking a folder offers to open a
// terminal in it; right-clicking a picture offers to make it the wallpaper; an
// untrusted launcher offers to be trusted; and the first entry names the
// application that will actually open the file. This module reproduces that:
// the menu is rebuilt on every click from the selection in front of it.

import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';

import {_, format, ngettext} from '../core/gettext.js';

// Things that can sensibly be *run* rather than opened. Executability alone is
// not the test: a .sh the user never chmod'ed is still a script they mean to
// run, and running it through its interpreter needs no permission change.
const SCRIPT_TYPES = new Set([
    'application/x-shellscript', 'text/x-shellscript',
    'application/x-python', 'text/x-python', 'text/x-python3',
    'application/x-perl', 'text/x-perl',
    'application/x-ruby', 'text/x-ruby',
    'application/x-lua', 'text/x-lua',
    'application/x-executable', 'application/x-sharedlib',
]);

// Content types we can act on beyond opening. Kept explicit rather than
// pattern-matched on the string: "image/" would sweep in things like
// image/vnd.djvu, which is not a wallpaper.
const WALLPAPER_TYPES = new Set([
    'image/jpeg', 'image/png', 'image/webp', 'image/avif',
    'image/tiff', 'image/bmp', 'image/svg+xml', 'image/heif',
]);

/**
 * @param {object[]} items - the current selection, never empty
 * @returns {Gio.Menu} a menu describing exactly these items
 */
export function buildItemMenu(items) {
    const menu = new Gio.Menu();
    const single = items.length === 1 ? items[0] : null;
    // Home, the wastebasket and volumes are not files in this folder. Renaming
    // or trashing them is meaningless, so those entries are simply absent
    // rather than present and greyed.
    const editable = items.every(item => !item.special);

    menu.append_section(null, openSection(items, single));

    const specific = contextSection(single);
    if (specific.get_n_items() > 0)
        menu.append_section(null, specific);

    if (editable) {
        // Cut and Copy earn their place even though Ctrl+X and Ctrl+C exist:
        // Paste lives in the background menu, and a paste with no discoverable
        // copy is a dead end.
        const edit = new Gio.Menu();
        edit.append(_('Cut'), 'desktop.cut');
        edit.append(_('Copy'), 'desktop.copy');
        if (single)
            edit.append(_('Rename…'), 'desktop.rename');
        edit.append(items.length > 1 ? format(ngettext('Move %d Item to Trash', 'Move %d Items to Trash', items.length), items.length) : _('Move to Trash'),
            'desktop.trash');
        menu.append_section(null, edit);
    }

    const info = new Gio.Menu();
    info.append(_('Properties'), 'desktop.properties');
    menu.append_section(null, info);

    return menu;
}

/**
 * @param {object[]} items - the selection
 * @param {?object} single - the item, when exactly one is selected
 * @returns {Gio.Menu} the opening entries
 */
function openSection(items, single) {
    const section = new Gio.Menu();

    // Name the application, the way Files does, so the user knows what will
    // happen before it happens.
    const handler = single ? defaultHandler(single) : null;
    if (handler)
        section.append(format(_('Open with %s'), handler.get_display_name()), 'desktop.open');
    else if (items.length > 1)
        section.append(format(ngettext('Open %d Item', 'Open %d Items', items.length), items.length), 'desktop.open');
    else
        section.append(_('Open'), 'desktop.open');

    if (single)
        section.append(_('Open With…'), 'desktop.open-with');

    return section;
}

/**
 * @param {?object} single - the item, when exactly one is selected
 * @returns {Gio.Menu} entries that only make sense for this kind of file
 */
function contextSection(single) {
    const section = new Gio.Menu();
    if (!single)
        return section;

    if (single.special === 'trash') {
        const item = Gio.MenuItem.new(_('Empty Wastebasket'), 'desktop.empty-trash');
        section.append_item(item);
        return section;
    }

    if (single.special === 'volume') {
        if (single.canEject)
            section.append(_('Eject'), 'desktop.eject');
        section.append(_('Open in Terminal'), 'desktop.open-terminal');
        return section;
    }

    if (single.isDirectory)
        section.append(_('Open in Terminal'), 'desktop.open-terminal');

    // Run only as the user. Running a desktop script as root would be a
    // privileged subprocess, which the review guidelines say must go through
    // pkexec *and* must not be a script a user process can modify — and a file
    // on your own desktop is exactly that. The two conditions cannot both hold,
    // so the terminal opens unprivileged and `sudo` is one word away.
    if (isRunnable(single))
        section.append(_('Run in Terminal'), 'desktop.run');

    if (!single.special && WALLPAPER_TYPES.has(single.contentType))
        section.append(_('Set as Background'), 'desktop.set-background');

    // An unexecutable desktop entry is just a text file until the user says
    // otherwise — the same guard Files puts in front of launchers.
    if (single.contentType === 'application/x-desktop' && !single.isExecutable)
        section.append(_('Allow Launching'), 'desktop.allow-launching');

    return section;
}

/**
 * @param {object} item - a FileModel item
 * @returns {boolean} whether "Run in Terminal" makes sense for it
 */
export function isRunnable(item) {
    if (item.special || item.isDirectory)
        return false;

    // A desktop entry is launched, not run in a shell; it has its own menu item.
    if (item.contentType === 'application/x-desktop')
        return false;

    return SCRIPT_TYPES.has(item.contentType) || item.isExecutable;
}

/**
 * @param {object} item - a FileModel item
 * @returns {?Gio.AppInfo} the application that would open it
 */
export function defaultHandler(item) {
    if (item.isDirectory)
        return Gio.AppInfo.get_default_for_type('inode/directory', false);

    // A trusted launcher opens itself; naming another application would be a
    // lie about what double-clicking does.
    if (item.contentType === 'application/x-desktop' && item.isExecutable)
        return null;

    return Gio.AppInfo.get_default_for_type(item.contentType, false);
}

/**
 * Whether opening this item means launching it rather than handing it to a
 * viewer. Mirrors the check Files makes: a desktop entry is only launched when
 * the user has marked it executable, otherwise it is just a text file.
 *
 * @param {object} item - a FileModel item
 * @returns {boolean} true when the item is a launcher we may run
 */
export function isTrustedLauncher(item) {
    return item.contentType === 'application/x-desktop' && item.isExecutable;
}

/**
 * The display's launch context, stamped with the current time. Launch through
 * it rather than with a null one: it carries the startup-notification id and
 * the display environment, which is what tells the new process which monitor
 * and which scale factor it is starting on; without it some applications come
 * up at the wrong size.
 *
 * @param {Gdk.Display} display - the display to launch on
 * @returns {Gdk.AppLaunchContext} the context, ready to launch with
 */
export function launchContext(display) {
    const context = display.get_app_launch_context();
    context.set_timestamp(Gdk.CURRENT_TIME);
    return context;
}

/**
 * @param {object[]} items - the current selection
 * @returns {object} which dynamic actions apply, for enabling menu entries
 */
export function actionAvailability(items) {
    const single = items.length === 1 ? items[0] : null;

    const editable = items.every(item => !item.special);

    return {
        'open-terminal': Boolean(single?.isDirectory),
        'empty-trash': single?.special === 'trash' && !single.trashEmpty,
        'run': Boolean(single && isRunnable(single)),
        'eject': Boolean(single?.special === 'volume' && single.canEject),
        'set-background': Boolean(single && WALLPAPER_TYPES.has(single.contentType)),
        'allow-launching': Boolean(single &&
            single.contentType === 'application/x-desktop' && !single.isExecutable),
        'open-with': Boolean(single && !single.special),
        'rename': Boolean(single && !single.special),
        'open': items.length > 0,
        'cut': items.length > 0 && editable,
        'copy': items.length > 0 && editable,
        'trash': items.length > 0 && editable,
        'properties': items.length > 0,
    };
}
