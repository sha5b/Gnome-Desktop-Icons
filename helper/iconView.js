// SPDX-License-Identifier: GPL-2.0-or-later
//
// The grid of icons on one monitor: layout, selection, input and menus.
//
// Icons are placed on a Gtk.Fixed rather than a flow container. The desktop is
// not a list — a file has a *position*, users drag icons where they want them,
// and M3 has to restore those positions from the file's
// metadata::nautilus-icon-position attribute. A layout container would fight
// that. Until then the slot allocator fills the grid in column order, the way
// Files does.

import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {DesktopIcon} from './desktopIcon.js';
import {actionAvailability, buildItemMenu} from './itemMenu.js';
import {openTerminal} from './terminal.js';

const CELL_PADDING = 12;
const EDGE_MARGIN = 16;

export const IconView = GObject.registerClass(
class IconView extends Gtk.Fixed {
    _init(params) {
        const {iconSize, thumbnails, operations, onOpen, ...fixedParams} = params;

        super._init(fixedParams);

        this._iconSize = iconSize;
        this._thumbnails = thumbnails;
        this._operations = operations;
        this._onOpen = onOpen;

        this._icons = [];
        this._selection = new Set();
        this._workArea = null;
        this._directory = null;

        this.add_css_class('icon-view');
        this.set_focusable(true);

        this._buildMenus();
        this._addControllers();
    }

    /**
     * @param {Gio.File} directory - the directory being shown
     * @param {object[]} items - items from the FileModel, already sorted
     */
    setItems(directory, items) {
        this._directory = directory;

        const stillHere = new Set(items.map(item => item.uri));
        for (const uri of [...this._selection]) {
            if (!stillHere.has(uri))
                this._selection.delete(uri);
        }

        for (const icon of this._icons)
            this.remove(icon);
        this._icons = [];

        for (const item of items) {
            const icon = new DesktopIcon({
                item,
                iconSize: this._iconSize,
                cellWidth: this._cellWidth(),
            });
            icon.setSelected(this._selection.has(item.uri));
            this._icons.push(icon);
            this.put(icon, 0, 0);
            this._thumbnails.request(item, texture => icon.setThumbnail(texture));
        }

        this._layout();
    }

    /**
     * @param {object} monitor - the monitor snapshot this view covers
     */
    setGeometry(monitor) {
        this._workArea = monitor.workArea;
        this._layout();
    }

    // --- layout ---

    _cellWidth() {
        return this._iconSize + CELL_PADDING * 4;
    }

    _cellHeight() {
        // Icon, gap, and two lines of label.
        return this._iconSize + CELL_PADDING * 2 + 40;
    }

    _layout() {
        if (!this._workArea)
            return;

        const cellWidth = this._cellWidth();
        const cellHeight = this._cellHeight();
        // The window covers the whole monitor, but icons live inside the work
        // area so they never sit under the top panel or a dock.
        const originX = this._workArea.x + EDGE_MARGIN;
        const originY = this._workArea.y + EDGE_MARGIN;
        const usableHeight = this._workArea.height - EDGE_MARGIN * 2;
        const rows = Math.max(1, Math.floor(usableHeight / cellHeight));

        this._icons.forEach((icon, index) => {
            const column = Math.floor(index / rows);
            const row = index % rows;
            this.move(icon, originX + column * cellWidth, originY + row * cellHeight);
        });
    }

    // --- selection ---

    _selectOnly(item) {
        this._selection.clear();
        if (item)
            this._selection.add(item.uri);
        this._refreshSelection();
    }

    _toggle(item) {
        if (this._selection.has(item.uri))
            this._selection.delete(item.uri);
        else
            this._selection.add(item.uri);
        this._refreshSelection();
    }

    _selectAll() {
        for (const icon of this._icons)
            this._selection.add(icon.item.uri);
        this._refreshSelection();
    }

    _refreshSelection() {
        for (const icon of this._icons)
            icon.setSelected(this._selection.has(icon.item.uri));
    }

    /** @returns {object[]} the selected items, in display order */
    get selectedItems() {
        return this._icons.filter(icon => this._selection.has(icon.item.uri))
            .map(icon => icon.item);
    }

    _iconAt(x, y) {
        // Gtk.Fixed does not pick for us; the icons are laid out on a grid, so
        // a bounds test is both simple and exact.
        return this._icons.find(icon => {
            const bounds = icon.compute_bounds(this)[1];
            return bounds && x >= bounds.get_x() && x < bounds.get_x() + bounds.get_width() &&
                y >= bounds.get_y() && y < bounds.get_y() + bounds.get_height();
        }) ?? null;
    }

    // --- input ---

    _addControllers() {
        const primary = new Gtk.GestureClick({button: Gdk.BUTTON_PRIMARY});
        primary.connect('pressed', (gesture, nPress, x, y) =>
            this._onPrimaryPressed(gesture, nPress, x, y));
        this.add_controller(primary);

        const secondary = new Gtk.GestureClick({button: Gdk.BUTTON_SECONDARY});
        secondary.connect('pressed', (_gesture, _nPress, x, y) =>
            this._onSecondaryPressed(x, y));
        this.add_controller(secondary);

        const keys = new Gtk.EventControllerKey();
        keys.connect('key-pressed', (_controller, keyval, _code, state) =>
            this._onKeyPressed(keyval, state));
        this.add_controller(keys);
    }

    _onPrimaryPressed(gesture, nPress, x, y) {
        this.grab_focus();

        const icon = this._iconAt(x, y);
        if (!icon) {
            this._selectOnly(null);
            return;
        }

        const state = gesture.get_current_event_state();
        const extend = (state & Gdk.ModifierType.CONTROL_MASK) !== 0 ||
            (state & Gdk.ModifierType.SHIFT_MASK) !== 0;

        if (extend) {
            this._toggle(icon.item);
            return;
        }

        if (!this._selection.has(icon.item.uri))
            this._selectOnly(icon.item);

        if (nPress === 2)
            this._onOpen([icon.item]);
    }

    _onSecondaryPressed(x, y) {
        this.grab_focus();

        const icon = this._iconAt(x, y);
        if (icon && !this._selection.has(icon.item.uri))
            this._selectOnly(icon.item);
        else if (!icon)
            this._selectOnly(null);

        if (icon)
            this._popupItemMenu(x, y);
        else
            this._popupBackgroundMenu(x, y);
    }

    _onKeyPressed(keyval, state) {
        const control = (state & Gdk.ModifierType.CONTROL_MASK) !== 0;

        switch (keyval) {
        case Gdk.KEY_a:
            if (!control)
                return Gdk.EVENT_PROPAGATE;
            this._selectAll();
            return Gdk.EVENT_STOP;
        case Gdk.KEY_Return:
        case Gdk.KEY_KP_Enter:
            this._onOpen(this.selectedItems);
            return Gdk.EVENT_STOP;
        case Gdk.KEY_Delete:
        case Gdk.KEY_KP_Delete:
            this._trashSelection();
            return Gdk.EVENT_STOP;
        case Gdk.KEY_Escape:
            this._selectOnly(null);
            return Gdk.EVENT_STOP;
        case Gdk.KEY_Left:
        case Gdk.KEY_Right:
        case Gdk.KEY_Up:
        case Gdk.KEY_Down:
            this._moveSelection(keyval);
            return Gdk.EVENT_STOP;
        default:
            return Gdk.EVENT_PROPAGATE;
        }
    }

    _moveSelection(keyval) {
        if (this._icons.length === 0)
            return;

        const rows = Math.max(1, Math.floor(
            (this._workArea.height - EDGE_MARGIN * 2) / this._cellHeight()));
        const current = this._icons.findIndex(icon => this._selection.has(icon.item.uri));
        const step = {
            [Gdk.KEY_Up]: -1,
            [Gdk.KEY_Down]: 1,
            [Gdk.KEY_Left]: -rows,
            [Gdk.KEY_Right]: rows,
        }[keyval];

        const next = Math.min(this._icons.length - 1,
            Math.max(0, (current < 0 ? 0 : current + step)));
        this._selectOnly(this._icons[next].item);
    }

    // --- menus ---

    _buildMenus() {
        this._actions = new Gio.SimpleActionGroup();
        for (const [name, activate] of Object.entries(this._actionHandlers())) {
            const action = new Gio.SimpleAction({name});
            action.connect('activate', activate);
            this._actions.add_action(action);
        }
        this.insert_action_group('desktop', this._actions);

        // The background menu is the same whatever is under the pointer, so it
        // is built once. The item menu is built per click; see _popupItemMenu.
        const background = new Gio.Menu();

        const create = new Gio.Menu();
        create.append('New Folder', 'desktop.new-folder');
        background.append_section(null, create);

        const open = new Gio.Menu();
        open.append('Open in Terminal', 'desktop.open-terminal-here');
        open.append('Open Desktop in Files', 'desktop.open-desktop');
        open.append('Select All', 'desktop.select-all');
        background.append_section(null, open);

        const settings = new Gio.Menu();
        settings.append('Change Background…', 'desktop.change-background');
        settings.append('Display Settings', 'desktop.display-settings');
        background.append_section(null, settings);

        this._menu = new Gtk.PopoverMenu({has_arrow: false, halign: Gtk.Align.START});
        this._menu.set_parent(this);
        this._backgroundModel = background;
    }

    _popupItemMenu(x, y) {
        const items = this.selectedItems;
        const available = actionAvailability(items);
        for (const [name, enabled] of Object.entries(available))
            this._actions.lookup_action(name)?.set_enabled(enabled);

        this._popup(buildItemMenu(items), x, y);
    }

    _popupBackgroundMenu(x, y) {
        this._popup(this._backgroundModel, x, y);
    }

    _popup(model, x, y) {
        this._menu.set_menu_model(model);
        this._menu.set_pointing_to(new Gdk.Rectangle({x, y, width: 1, height: 1}));
        this._menu.popup();
    }

    _actionHandlers() {
        return {
            'open': () => this._onOpen(this.selectedItems),
            'open-with': () => this._openWith(),
            'open-terminal': () => this._openTerminalInSelection(),
            'set-background': () => this._setBackground(),
            'allow-launching': () => this._allowLaunching(),
            'show-in-files': () => this._operations.showItems(this._selectedUris()),
            'properties': () => this._operations.showProperties(this._selectedUris()),
            'trash': () => this._trashSelection(),
            'select-all': () => this._selectAll(),
            'new-folder': () => this._newFolder(),
            'open-terminal-here': () => openTerminal(this._directory),
            'open-desktop': () => launchUri(this._directory.get_uri()),
            'change-background': () => launchSettings('background'),
            'display-settings': () => launchSettings('display'),
        };
    }

    _openTerminalInSelection() {
        const [item] = this.selectedItems;
        if (item?.isDirectory)
            openTerminal(item.file);
    }

    _setBackground() {
        const [item] = this.selectedItems;
        if (!item)
            return;

        // Both keys, or the wallpaper only changes in one of light and dark.
        const settings = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
        settings.set_string('picture-uri', item.uri);
        settings.set_string('picture-uri-dark', item.uri);
    }

    _allowLaunching() {
        const [item] = this.selectedItems;
        if (!item)
            return;

        // Files marks a launcher trusted by making it executable and stamping
        // metadata::trusted; do both, so Files agrees with us afterwards.
        try {
            const info = new Gio.FileInfo();
            info.set_attribute_uint32('unix::mode', 0o755);
            info.set_attribute_string('metadata::trusted', 'true');
            item.file.set_attributes_from_info(info, Gio.FileQueryInfoFlags.NONE, null);
        } catch (error) {
            printerr(`iconView: cannot trust ${item.name}: ${error.message}`);
        }
    }

    _selectedUris() {
        return this.selectedItems.map(item => item.uri);
    }

    _trashSelection() {
        const uris = this._selectedUris();
        if (uris.length > 0)
            this._operations.trash(uris);
    }

    _newFolder() {
        this._operations.createFolder(this._directory.get_uri(),
            uniqueName(this._directory, 'Untitled Folder'));
    }

    _openWith() {
        const [item] = this.selectedItems;
        if (!item)
            return;

        // Nautilus owns the "choose an application" experience; reuse it rather
        // than building a second, worse chooser.
        const dialog = new Gtk.FileLauncher({file: item.file});
        dialog.set_always_ask(true);
        dialog.launch(this.get_root(), null, null);
    }
});

/**
 * @param {Gio.File} directory - where the new item goes
 * @param {string} base - the preferred name
 * @returns {string} a name that is not taken yet
 */
function uniqueName(directory, base) {
    if (!directory.get_child(base).query_exists(null))
        return base;

    for (let n = 2; ; n++) {
        const candidate = `${base} ${n}`;
        if (!directory.get_child(candidate).query_exists(null))
            return candidate;
    }
}

/**
 * @param {string} uri - what to hand to the default handler
 */
function launchUri(uri) {
    Gio.AppInfo.launch_default_for_uri_async(uri, null, null, null);
}

/**
 * @param {string} panel - a gnome-control-center panel name
 */
function launchSettings(panel) {
    try {
        GLib.spawn_async(null, ['gnome-control-center', panel], null,
            GLib.SpawnFlags.SEARCH_PATH, null);
    } catch (error) {
        printerr(`iconView: cannot open settings: ${error.message}`);
    }
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
