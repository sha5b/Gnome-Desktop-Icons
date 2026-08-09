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

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

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

    // Cut and Copy earn their place even though Ctrl+X and Ctrl+C exist: Paste
    // lives in the background menu, and a paste with no discoverable copy is a
    // dead end. "Show in Files" does not — the desktop already *is* that folder.
    const edit = new Gio.Menu();
    edit.append('Cut', 'desktop.cut');
    edit.append('Copy', 'desktop.copy');
    if (single)
        edit.append('Rename…', 'desktop.rename');
    edit.append(items.length > 1 ? `Move ${items.length} Items to Trash` : 'Move to Trash',
        'desktop.trash');
    menu.append_section(null, edit);

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
        section.append_submenu('Open With', openWithMenu(single));

    return section;
}

/**
 * Every application registered for this file's type.
 *
 * The entries are radio items bound to one stateful action, with the dot on
 * whichever application is currently the default. Activating an entry makes
 * that application the default *and* opens the file with it — which is what
 * picking an application from this list is nearly always meant to do, and it
 * saves a second trip through a dialog to make the choice stick.
 *
 * @param {object} item - the selected item
 * @returns {Gio.Menu} the submenu
 */
function openWithMenu(item) {
    const menu = new Gio.Menu();
    const type = item.isDirectory ? 'inode/directory' : item.contentType;

    // Recommended applications first — the ones that registered for this exact
    // type — then anything else that merely claims to cope with it.
    const seen = new Set();
    const applications = [
        ...Gio.AppInfo.get_recommended_for_type(type),
        ...Gio.AppInfo.get_all_for_type(type),
    ].filter(application => {
        const id = application.get_id();
        if (!id || seen.has(id) || !application.should_show())
            return false;

        seen.add(id);
        return true;
    });

    const applicationSection = new Gio.Menu();
    for (const application of applications) {
        const entry = Gio.MenuItem.new(application.get_display_name(), null);
        entry.set_action_and_target_value('desktop.default-app',
            new GLib.Variant('s', application.get_id()));
        applicationSection.append_item(entry);
    }

    if (applications.length > 0)
        menu.append_section(null, applicationSection);

    const other = new Gio.Menu();
    other.append('Other Application…', 'desktop.open-with');
    menu.append_section(null, other);

    return menu;
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
 * @returns {string} the id of its default application, or "" if it has none
 */
export function defaultApplicationId(item) {
    return defaultHandler(item)?.get_id() ?? '';
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
        'rename': Boolean(single),
        'open': items.length > 0,
        'cut': items.length > 0,
        'copy': items.length > 0,
        'trash': items.length > 0,
        'properties': items.length > 0,
    };
}
