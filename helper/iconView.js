// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright 2026 Shahab Nedaei <ned.tabulov@gmail.com>
//
// The grid of icons on one monitor: layout, selection, input and menus.
//
// Icons are placed on a Gtk.Fixed rather than a flow container. The desktop is
// not a list — a file has a *position*, dragged there by the user and restored
// from the file's metadata::nautilus-icon-position attribute. A layout
// container would fight that.
//
// Positions snap to a grid. Arranged icons keep their slot; everything else
// fills the gaps in column order, so dropping a new file into the folder never
// reshuffles the icons the user has already placed.

import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {DesktopIcon} from './desktopIcon.js';
import {actionAvailability, buildItemMenu, defaultApplicationId} from './itemMenu.js';
import {addDragSource, addDropTarget} from './dragAndDrop.js';
import {clearPosition, writePosition} from './iconPositions.js';
import {ClickPolicy} from './clickPolicy.js';
import {RenamePopover} from './renamePopover.js';
import {openTerminal} from './terminal.js';
import {pasteFromClipboard, setClipboard} from './clipboard.js';

const CELL_PADDING = 12;
const EDGE_MARGIN = 16;
// How long a type-ahead search stays open after the last keystroke.
const TYPE_AHEAD_MILLISECONDS = 1000;

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
        this._typeAhead = '';
        this._typeAheadId = 0;

        this._clickPolicy = new ClickPolicy(() => {});
        this._rename = new RenamePopover({
            onCommit: (item, name) => this._operations.rename(item.uri, name),
        });
        this._rename.set_parent(this);

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
        this._allItems = items;

        const mine = items.filter(item => this._ownsItem(item));
        const stillHere = new Set(mine.map(item => item.uri));
        for (const uri of [...this._selection]) {
            if (!stillHere.has(uri))
                this._selection.delete(uri);
        }

        for (const icon of this._icons)
            this.remove(icon);
        this._icons = [];

        for (const item of mine) {
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
        this._monitor = monitor;
        // The snapshot is in global coordinates; this widget's are relative to
        // its own monitor. Without the shift, everything on a second monitor
        // would be laid out off the right-hand edge of the world.
        this._workArea = {
            x: monitor.workArea.x - monitor.x,
            y: monitor.workArea.y - monitor.y,
            width: monitor.workArea.width,
            height: monitor.workArea.height,
        };

        if (this._allItems)
            this.setItems(this._directory, this._allItems);
        else
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

    /**
     * Which monitor an item belongs to. A saved position names one implicitly,
     * by falling inside its work area; anything never dragged lives on the
     * primary monitor.
     *
     * @param {object} item - a FileModel item
     * @returns {boolean} whether this view should draw it
     */
    _ownsItem(item) {
        if (!this._monitor)
            return false;

        if (!item.position)
            return this._monitor.primary;

        return this._containsGlobal(item.position.x, item.position.y);
    }

    _containsGlobal(x, y) {
        const {workArea} = this._monitor;
        return x >= workArea.x && x < workArea.x + workArea.width &&
            y >= workArea.y && y < workArea.y + workArea.height;
    }

    /** @returns {object} the grid's origin, spacing and extent, monitor-local */
    _grid() {
        const cellWidth = this._cellWidth();
        const cellHeight = this._cellHeight();
        // The window covers the whole monitor, but icons live inside the work
        // area so they never sit under the top panel or a dock.
        return {
            cellWidth,
            cellHeight,
            originX: this._workArea.x + EDGE_MARGIN,
            originY: this._workArea.y + EDGE_MARGIN,
            columns: Math.max(1,
                Math.floor((this._workArea.width - EDGE_MARGIN * 2) / cellWidth)),
            rows: Math.max(1,
                Math.floor((this._workArea.height - EDGE_MARGIN * 2) / cellHeight)),
        };
    }

    /**
     * @param {number} x - monitor-local x
     * @param {number} y - monitor-local y
     * @returns {object} the {column, row} slot nearest that point
     */
    _slotAt(x, y) {
        const {cellWidth, cellHeight, originX, originY, columns, rows} = this._grid();
        return {
            column: clamp(Math.round((x - originX) / cellWidth), 0, columns - 1),
            row: clamp(Math.round((y - originY) / cellHeight), 0, rows - 1),
        };
    }

    /**
     * @param {object} slot - a grid slot
     * @param {number} slot.column - its column
     * @param {number} slot.row - its row
     * @returns {object} its top-left corner, monitor-local
     */
    _slotOrigin({column, row}) {
        const {cellWidth, cellHeight, originX, originY} = this._grid();
        return {x: originX + column * cellWidth, y: originY + row * cellHeight};
    }

    _layout() {
        if (!this._workArea)
            return;

        const {rows} = this._grid();
        const taken = new Set();
        const placed = new Map();

        // Icons the user has arranged keep their slot. Everything else fills
        // the gaps in column order, which is how Files lays out a fresh
        // desktop, so adding a file never reshuffles the arranged ones.
        for (const icon of this._icons) {
            const {position} = icon.item;
            if (!position)
                continue;

            const slot = this._slotAt(position.x - this._monitor.x, position.y - this._monitor.y);
            const key = slotKey(slot);
            if (taken.has(key))
                continue;

            taken.add(key);
            placed.set(icon, slot);
        }

        let next = 0;
        for (const icon of this._icons) {
            if (placed.has(icon))
                continue;

            let slot;
            let key;
            do {
                slot = {column: Math.floor(next / rows), row: next % rows};
                key = slotKey(slot);
                next++;
            } while (taken.has(key));

            taken.add(key);
            placed.set(icon, slot);
        }

        for (const [icon, slot] of placed) {
            const {x, y} = this._slotOrigin(slot);
            this.move(icon, x, y);
        }
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

        this._addDragSource();

        addDropTarget(this, {
            onFiles: (files, x, y, action) => this._onFilesDropped(files, x, y, action),
            onText: (text, x, y) => this._onTextDropped(text, x, y),
            onTexture: (texture, x, y) => this._onTextureDropped(texture, x, y),
            onMotion: (x, y) => this._onDragMotion(x, y),
            onLeave: () => this._clearDropHighlight(),
        });
    }

    // --- drag out ---

    _addDragSource() {
        addDragSource(this, {
            onPrepareAt: (x, y) => {
                const icon = this._iconAt(x, y);
                if (!icon)
                    return null;

                // Dragging an unselected icon drags that icon, not the stale
                // selection behind it.
                if (!this._selection.has(icon.item.uri))
                    this._selectOnly(icon.item);

                return {items: this.selectedItems, widget: icon};
            },
            onBegin: () => this.add_css_class('dragging'),
            onEnd: () => this.remove_css_class('dragging'),
        });
    }

    // --- drop in ---

    _onDragMotion(x, y) {
        // Highlight only; the action GTK is told about is decided in
        // dragAndDrop.js, which has the Gdk.Drop and its modifiers to hand.
        const icon = this._iconAt(x, y);
        const target = icon?.item.isDirectory ? icon : null;

        if (this._dropTargetIcon !== target) {
            this._dropTargetIcon?.remove_css_class('drop-target');
            target?.add_css_class('drop-target');
            this._dropTargetIcon = target;
        }
    }

    _clearDropHighlight() {
        this._dropTargetIcon?.remove_css_class('drop-target');
        this._dropTargetIcon = null;
    }

    _onFilesDropped(files, x, y, action) {
        this._clearDropHighlight();
        if (files.length === 0)
            return;

        const uris = files.map(file => file.get_uri());
        const folder = this._iconAt(x, y);
        if (folder?.item.isDirectory && !this._isOurs(files[0])) {
            this._transfer(uris, folder.item.uri, action);
            return;
        }

        // Files already on this desktop are being rearranged, not copied.
        if (files.every(file => this._isOurs(file))) {
            this._repositionDroppedIcons(files, x, y);
            return;
        }

        this._transfer(uris, this._directory.get_uri(), action);
    }

    _isOurs(file) {
        const parent = file.get_parent();
        return parent !== null && parent.equal(this._directory);
    }

    _transfer(uris, destinationUri, action) {
        if (action === Gdk.DragAction.MOVE)
            this._operations.move(uris, destinationUri);
        else if (action === Gdk.DragAction.LINK)
            this._linkInto(uris, destinationUri);
        else
            this._operations.copy(uris, destinationUri);
    }

    _linkInto(uris, destinationUri) {
        // FileOperations2 has no "make a symlink" call, so this one is ours.
        const destination = Gio.File.new_for_uri(destinationUri);
        for (const uri of uris) {
            const source = Gio.File.new_for_uri(uri);
            const link = destination.get_child(source.get_basename());
            try {
                link.make_symbolic_link(source.get_path(), null);
            } catch (error) {
                printerr(`iconView: cannot link ${uri}: ${error.message}`);
            }
        }
    }

    /**
     * Lay the dragged icons out from the drop point, keeping their order, and
     * remember where each landed.
     *
     * @param {Gio.File[]} files - the dropped files
     * @param {number} x - drop point, monitor-local
     * @param {number} y - drop point, monitor-local
     */
    _repositionDroppedIcons(files, x, y) {
        const {rows} = this._grid();
        const dropped = new Set(files.map(file => file.get_uri()));
        const occupied = new Set();

        for (const icon of this._icons) {
            if (dropped.has(icon.item.uri))
                continue;
            const bounds = icon.compute_bounds(this)[1];
            if (bounds)
                occupied.add(slotKey(this._slotAt(bounds.get_x(), bounds.get_y())));
        }

        const start = this._slotAt(x - this._cellWidth() / 2, y - this._cellHeight() / 2);
        let offset = 0;

        for (const uri of dropped) {
            const item = this._icons.find(icon => icon.item.uri === uri)?.item;
            if (!item)
                continue;

            let slot;
            do {
                const index = start.column * rows + start.row + offset;
                slot = {column: Math.floor(index / rows), row: index % rows};
                offset++;
            } while (occupied.has(slotKey(slot)));

            occupied.add(slotKey(slot));
            const origin = this._slotOrigin(slot);
            const position = {
                x: this._monitor.x + origin.x,
                y: this._monitor.y + origin.y,
            };

            // Move the icon now, then persist. A metadata write is not a file
            // change, so the directory monitor never fires for it — waiting for
            // the model to come back would mean waiting forever, and the icon
            // would snap back to where it started.
            item.position = position;
            writePosition(item.file, position.x, position.y);
        }

        this._layout();
    }

    _onTextDropped(text, x, y) {
        this._createDroppedFile('Dropped Text.txt',
            new TextEncoder().encode(text), x, y);
    }

    _onTextureDropped(texture, x, y) {
        this._createDroppedFile('Dropped Image.png',
            texture.save_to_png_bytes().get_data(), x, y);
    }

    /**
     * @param {string} baseName - the preferred name
     * @param {Uint8Array} contents - what to write
     * @param {number} x - drop point, monitor-local
     * @param {number} y - drop point, monitor-local
     */
    _createDroppedFile(baseName, contents, x, y) {
        this._clearDropHighlight();

        const file = this._directory.get_child(uniqueName(this._directory, baseName));
        try {
            file.replace_contents(contents, null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (error) {
            printerr(`iconView: cannot write ${file.get_basename()}: ${error.message}`);
            return;
        }

        const origin = this._slotOrigin(this._slotAt(x, y));
        writePosition(file, this._monitor.x + origin.x, this._monitor.y + origin.y);
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

        const opensAt = this._clickPolicy.singleClick ? 1 : 2;
        if (nPress === opensAt)
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
        case Gdk.KEY_x:
            if (!control)
                return Gdk.EVENT_PROPAGATE;
            this._toClipboard('cut');
            return Gdk.EVENT_STOP;
        case Gdk.KEY_c:
            if (!control)
                return Gdk.EVENT_PROPAGATE;
            this._toClipboard('copy');
            return Gdk.EVENT_STOP;
        case Gdk.KEY_v:
            if (!control)
                return Gdk.EVENT_PROPAGATE;
            this._paste();
            return Gdk.EVENT_STOP;
        case Gdk.KEY_z:
            if (!control)
                return Gdk.EVENT_PROPAGATE;
            this._operations.undo();
            return Gdk.EVENT_STOP;
        case Gdk.KEY_Return:
        case Gdk.KEY_KP_Enter:
            this._onOpen(this.selectedItems);
            return Gdk.EVENT_STOP;
        case Gdk.KEY_Delete:
        case Gdk.KEY_KP_Delete:
            this._trashSelection();
            return Gdk.EVENT_STOP;
        case Gdk.KEY_F2:
            this._renameSelection();
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
            return control ? Gdk.EVENT_PROPAGATE : this._typeAheadKey(keyval);
        }
    }

    /**
     * Jump to the first item whose name starts with what has been typed, the
     * way every file list does. Keystrokes accumulate until a pause.
     *
     * @param {number} keyval - the key pressed
     * @returns {boolean} whether the key was consumed
     */
    _typeAheadKey(keyval) {
        const unichar = Gdk.keyval_to_unicode(keyval);
        if (unichar === 0)
            return Gdk.EVENT_PROPAGATE;

        const character = String.fromCharCode(unichar);
        if (character.trim() === '' && character !== ' ')
            return Gdk.EVENT_PROPAGATE;

        this._typeAhead += character;
        this._restartTypeAheadTimer();

        const prefix = this._typeAhead.toLowerCase();
        const match = this._icons.find(icon =>
            icon.item.displayName.toLowerCase().startsWith(prefix));
        if (match)
            this._selectOnly(match.item);

        return Gdk.EVENT_STOP;
    }

    _restartTypeAheadTimer() {
        if (this._typeAheadId)
            GLib.Source.remove(this._typeAheadId);

        this._typeAheadId = GLib.timeout_add_once(GLib.PRIORITY_DEFAULT,
            TYPE_AHEAD_MILLISECONDS, () => {
                this._typeAheadId = 0;
                this._typeAhead = '';
            });
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
        // Stateful: its value is the id of the current default application, so
        // the Open With list can show a radio dot on the right entry.
        this._defaultApp = Gio.SimpleAction.new_stateful('default-app',
            GLib.VariantType.new('s'), GLib.Variant.new_string(''));
        this._defaultApp.connect('activate',
            (_action, parameter) => this._openWithApplication(parameter.deepUnpack()));
        this._actions.add_action(this._defaultApp);

        this.insert_action_group('desktop', this._actions);

        // The background menu is the same whatever is under the pointer, so it
        // is built once. The item menu is built per click; see _popupItemMenu.
        const background = new Gio.Menu();

        const create = new Gio.Menu();
        create.append('New Folder', 'desktop.new-folder');
        background.append_section(null, create);

        // Five entries, and each one is the only way to reach what it does.
        // Dropped: Select All and Undo (Ctrl+A, Ctrl+Z), Open Desktop in Files
        // (the desktop already is that folder), and Display Settings (nothing
        // to do with the desktop).
        const edit = new Gio.Menu();
        edit.append('Paste', 'desktop.paste');
        background.append_section(null, edit);

        const open = new Gio.Menu();
        open.append('Open in Terminal', 'desktop.open-terminal-here');
        open.append('Tidy Up Icons', 'desktop.tidy-up');
        background.append_section(null, open);

        const settings = new Gio.Menu();
        settings.append('Change Background…', 'desktop.change-background');
        background.append_section(null, settings);

        this._menu = new Gtk.PopoverMenu({has_arrow: false, halign: Gtk.Align.START});
        this._menu.set_parent(this);
        this._backgroundModel = background;
    }

    _popupItemMenu(x, y) {
        const items = this.selectedItems;
        if (items.length === 1)
            this._defaultApp.set_state(GLib.Variant.new_string(defaultApplicationId(items[0])));

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
            'rename': () => this._renameSelection(),
            'cut': () => this._toClipboard('cut'),
            'copy': () => this._toClipboard('copy'),
            'paste': () => this._paste(),
            'undo': () => this._operations.undo(),
            'tidy-up': () => this._tidyUp(),
            'set-background': () => this._setBackground(),
            'allow-launching': () => this._allowLaunching(),
            'properties': () => this._operations.showProperties(this._selectedUris()),
            'trash': () => this._trashSelection(),
            'select-all': () => this._selectAll(),
            'new-folder': () => this._newFolder(),
            'open-terminal-here': () => openTerminal(this._directory),
            'change-background': () => launchSettings('background'),
        };
    }

    _renameSelection() {
        const [item] = this.selectedItems;
        if (!item)
            return;

        const icon = this._icons.find(candidate => candidate.item.uri === item.uri);
        const bounds = icon?.compute_bounds(this)[1];
        if (!bounds)
            return;

        this._rename.open(item, new Gdk.Rectangle({
            x: bounds.get_x(),
            y: bounds.get_y(),
            width: bounds.get_width(),
            height: bounds.get_height(),
        }));
    }

    _toClipboard(intent) {
        const items = this.selectedItems;
        if (items.length > 0)
            setClipboard(this.get_display().get_clipboard(), items, intent);
    }

    _paste() {
        pasteFromClipboard(this.get_display().get_clipboard(), (uris, intent) => {
            // Pasting into the folder they already live in would be a no-op at
            // best and a "copy 2" storm at worst.
            const incoming = uris.filter(uri => !this._isOurs(Gio.File.new_for_uri(uri)));
            if (incoming.length === 0)
                return;

            if (intent === 'cut')
                this._operations.move(incoming, this._directory.get_uri());
            else
                this._operations.copy(incoming, this._directory.get_uri());
        });
    }

    /** Forget every saved position, so the grid re-flows in sort order. */
    _tidyUp() {
        for (const icon of this._icons) {
            icon.item.position = null;
            clearPosition(icon.item.file);
        }

        this._layout();
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

    /**
     * Make the chosen application the default for this type, then open with it.
     *
     * @param {string} applicationId - a desktop file id
     */
    _openWithApplication(applicationId) {
        const [item] = this.selectedItems;
        if (!item)
            return;

        const application = Gio.DesktopAppInfo.new(applicationId);
        if (!application) {
            printerr(`iconView: no application with id ${applicationId}`);
            return;
        }

        const type = item.isDirectory ? 'inode/directory' : item.contentType;
        try {
            application.set_as_default_for_type(type);
        } catch (error) {
            printerr(`iconView: cannot make ${applicationId} the default: ${error.message}`);
        }

        const context = this.get_display().get_app_launch_context();
        context.set_timestamp(Gdk.CURRENT_TIME);
        try {
            application.launch_uris([item.uri], context);
        } catch (error) {
            printerr(`iconView: cannot open with ${applicationId}: ${error.message}`);
        }
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
 * @param {number} value - the number to bound
 * @param {number} low - lowest allowed
 * @param {number} high - highest allowed
 * @returns {number} value, brought inside [low, high]
 */
function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
}

/**
 * @param {object} slot - a grid slot
 * @param {number} slot.column - its column
 * @param {number} slot.row - its row
 * @returns {string} a key for Set membership
 */
function slotKey({column, row}) {
    return `${column},${row}`;
}

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
