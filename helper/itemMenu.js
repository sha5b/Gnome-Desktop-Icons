// SPDX-License-Identifier: GPL-2.0-or-later
//
// Builds the item context menu for whatever is actually selected.
//
// Files does not show one fixed menu. Right-clicking a folder offers to open a
// terminal in it; right-clicking a picture offers to make it the wallpaper; an
// untrusted launcher offers to be trusted; and the first entry names the
// application that will actually open the file. This module reproduces that:
// the menu is rebuilt on every click from the selection in front of it.

import Gio from 'gi://Gio';

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

    menu.append_section(null, openSection(items, single));

    const specific = contextSection(single);
    if (specific.get_n_items() > 0)
        menu.append_section(null, specific);

    const manage = new Gio.Menu();
    manage.append('Show in Files', 'desktop.show-in-files');
    manage.append(items.length > 1 ? `Move ${items.length} Items to Trash` : 'Move to Trash',
        'desktop.trash');
    menu.append_section(null, manage);

    const info = new Gio.Menu();
    info.append('Properties', 'desktop.properties');
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
        section.append(`Open with ${handler.get_display_name()}`, 'desktop.open');
    else if (items.length > 1)
        section.append(`Open ${items.length} Items`, 'desktop.open');
    else
        section.append('Open', 'desktop.open');

    if (single)
        section.append('Open With Other Application…', 'desktop.open-with');

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

    if (single.isDirectory)
        section.append('Open in Terminal', 'desktop.open-terminal');

    if (WALLPAPER_TYPES.has(single.contentType))
        section.append('Set as Background', 'desktop.set-background');

    // An unexecutable desktop entry is just a text file until the user says
    // otherwise — the same guard Files puts in front of launchers.
    if (single.contentType === 'application/x-desktop' && !single.isExecutable)
        section.append('Allow Launching', 'desktop.allow-launching');

    return section;
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
 * @param {object[]} items - the current selection
 * @returns {object} which dynamic actions apply, for enabling menu entries
 */
export function actionAvailability(items) {
    const single = items.length === 1 ? items[0] : null;

    return {
        'open-terminal': Boolean(single?.isDirectory),
        'set-background': Boolean(single && WALLPAPER_TYPES.has(single.contentType)),
        'allow-launching': Boolean(single &&
            single.contentType === 'application/x-desktop' && !single.isExecutable),
        'open-with': Boolean(single),
        'open': items.length > 0,
        'show-in-files': items.length > 0,
        'trash': items.length > 0,
        'properties': items.length > 0,
    };
}
