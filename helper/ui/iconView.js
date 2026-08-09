// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright 2026 Shahab Nedaei <ned.tabulov@gmail.com>
//
// The grid of icons on one monitor: layout, selection, drag-and-drop and the
// clipboard. The menus live in menus.js, the keyboard in keyboard.js; both
// are handed this view and call back into it.
//
// Icons are placed on a Gtk.Fixed rather than a flow container. The desktop is
// not a list — a file has a *position*, dragged there by the user and restored
// from the file's metadata::nautilus-icon-position attribute. A layout
// container would fight that.
//
// Positions snap to a grid. Arranged icons keep their slot; everything else
// fills the gaps in column order, so dropping a new file into the folder never
// reshuffles the icons the user has already placed.

import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import {_} from '../core/gettext.js';
import {DesktopIcon} from './desktopIcon.js';
import {defaultHandler} from './itemMenu.js';
import {Menus} from './menus.js';
import {Keyboard} from './keyboard.js';
import {addDragSource, addDropTarget} from '../dnd/dragAndDrop.js';
import {clearPosition, writePosition} from '../model/iconPositions.js';
import {ClickPolicy} from '../ops/clickPolicy.js';
import {pasteFromClipboard, setClipboard} from '../dnd/clipboard.js';

const CELL_PADDING = 12;
const EDGE_MARGIN = 16;

// Drag-to-edge workspace flipping: how close to the left or right window edge
// the pointer must hover mid-drag, and for how long, before the desktop flips
// to the next workspace over.
const EDGE_ZONE = 24;
const EDGE_DWELL_MILLISECONDS = 500;

export const IconView = GObject.registerClass(
class IconView extends Gtk.Fixed {
    _init(params) {
        const {iconSize, iconSource, thumbnails, operations, onOpen,
            onSwitchWorkspace, ...fixedParams} = params;

        super._init(fixedParams);

        this._iconSize = iconSize;
        this._iconSource = iconSource ?? 'type';
        this._thumbnails = thumbnails;
        this._operations = operations;
        this._onOpen = onOpen;
        this._onSwitchWorkspace = onSwitchWorkspace ?? null;

        this._icons = [];
        this._selection = new Set();
        this._workArea = null;
        this._directory = null;

        // Every icon belongs to exactly one workspace; this view shows one of
        // them. The extension tells us which, over IPC; standalone there is
        // only ever workspace 0.
        this._activeWorkspace = 0;
        this._workspaceCount = 1;

        this._edgeZone = 0;
        this._edgeFiredZone = 0;
        this._edgeTimeoutId = 0;

        this._clickPolicy = new ClickPolicy(() => {});
        this._menus = new Menus(this);
        this._keyboard = new Keyboard(this);

        this.add_css_class('icon-view');
        this.set_focusable(true);

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
                appIcon: this._iconFor(item),
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

    /**
     * @param {number} active - the workspace now showing
     * @param {number} count - how many workspaces exist
     */
    setWorkspaces(active, count) {
        if (active === this._activeWorkspace && count === this._workspaceCount)
            return;

        this._activeWorkspace = active;
        this._workspaceCount = count;

        // A different set of icons owns this workspace: rebuild from the full
        // item list rather than patching the grid.
        if (this._allItems)
            this.setItems(this._directory, this._allItems);
    }

    /**
     * Tears down what widget destruction will not: the keyboard's pending
     * type-ahead source, the menus' parented popovers, the GSettings listener
     * behind the click policy, and a pending edge-flip timeout. Call before
     * the window holding the view is destroyed, or every rebuild leaks them.
     */
    destroy() {
        this._cancelEdgeFlip();
        this._keyboard.destroy();
        this._menus.destroy();
        this._clickPolicy.destroy();
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
     * Before any of that, the workspace decides: an icon is only drawn on the
     * workspace it belongs to. A position whose workspace no longer exists is
     * clamped to the last one for display only — the stored value is never
     * rewritten for this.
     *
     * @param {object} item - a FileModel item
     * @returns {boolean} whether this view should draw it
     */
    _ownsItem(item) {
        if (!this._monitor)
            return false;

        const workspace = item.position
            ? Math.min(item.position.ws, this._workspaceCount - 1)
            : 0;
        if (workspace !== this._activeWorkspace)
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
                slot = slotForIndex(next, rows);
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

        this._addDragSource();
        this._addRubberBand();

        addDropTarget(this, {
            onFiles: (files, x, y, action) => this._onFilesDropped(files, x, y, action),
            onText: (text, x, y) => this._onTextDropped(text, x, y),
            onTexture: (texture, x, y) => this._onTextureDropped(texture, x, y),
            onMotion: (x, y) => this._onDragMotion(x, y),
            onLeave: () => this._clearDropHighlight(),
        });
    }

    // --- rubber band ---

    /**
     * Sweep a rectangle over empty desktop to select what it touches.
     *
     * The drag source lives on this same widget, so the two have to agree on
     * who owns a press: a drag that starts on an icon moves that icon, a drag
     * that starts on bare desktop draws a band. This gesture denies the
     * sequence in the first case and lets the drag source have it.
     */
    _addRubberBand() {
        const gesture = new Gtk.GestureDrag({button: Gdk.BUTTON_PRIMARY});

        gesture.connect('drag-begin', (controller, startX, startY) => {
            if (this._iconAt(startX, startY)) {
                controller.set_state(Gtk.EventSequenceState.DENIED);
                return;
            }

            controller.set_state(Gtk.EventSequenceState.CLAIMED);
            this._bandAnchor = {x: startX, y: startY};
            this._bandBase = (gesture.get_current_event_state() &
                Gdk.ModifierType.CONTROL_MASK) !== 0
                ? new Set(this._selection)
                : new Set();

            this._band = new Gtk.Box({css_classes: ['rubber-band']});
            this._band.set_can_target(false);
            this.put(this._band, startX, startY);
        });

        gesture.connect('drag-update', (_controller, offsetX, offsetY) =>
            this._updateBand(offsetX, offsetY));

        gesture.connect('drag-end', (_controller, offsetX, offsetY) => {
            this._updateBand(offsetX, offsetY);
            this._endBand();
        });

        // A cancelled gesture — the pointer leaving, another grab — must not
        // leave the band painted on the desktop for ever.
        gesture.connect('cancel', () => this._endBand());

        this.add_controller(gesture);
    }

    _updateBand(offsetX, offsetY) {
        if (!this._band)
            return;

        const rect = {
            x: Math.min(this._bandAnchor.x, this._bandAnchor.x + offsetX),
            y: Math.min(this._bandAnchor.y, this._bandAnchor.y + offsetY),
            width: Math.abs(offsetX),
            height: Math.abs(offsetY),
        };

        this.move(this._band, rect.x, rect.y);
        this._band.set_size_request(Math.max(1, rect.width), Math.max(1, rect.height));

        this._selection = new Set(this._bandBase);
        for (const icon of this._icons) {
            if (intersects(rect, icon.compute_bounds(this)[1]))
                this._selection.add(icon.item.uri);
        }
        this._refreshSelection();
    }

    _endBand() {
        if (!this._band)
            return;

        this.remove(this._band);
        this._band = null;
        this._bandAnchor = null;
        this._bandBase = null;
    }

    // --- drag out ---

    /**
     * Frame the work area while a drag-out is in flight. The window covers the
     * whole monitor, but GTK cancels drops outside the work area — the dock
     * owns that strip — so show where a drop will actually land.
     */
    _showDropZone() {
        if (!this._workArea)
            return;

        this._dropZone = new Gtk.Box({css_classes: ['drop-zone']});
        this._dropZone.set_can_target(false);
        this.put(this._dropZone, this._workArea.x, this._workArea.y);
        this._dropZone.set_size_request(this._workArea.width, this._workArea.height);
    }

    _hideDropZone() {
        if (!this._dropZone)
            return;

        this.remove(this._dropZone);
        this._dropZone = null;
    }

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
            onBegin: () => {
                this.add_css_class('dragging');
                this._showDropZone();
            },
            onEnd: () => {
                this.remove_css_class('dragging');
                this._hideDropZone();
                this._resetEdgeFlip();
            },
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

        this._trackEdgeFlip(x);
    }

    /**
     * Workspace flipping: dwell on the left or right window edge mid-drag to
     * move to the previous or next workspace. The window covers the whole
     * monitor, so the view-local x is effectively the screen-local one, and
     * the sticky window — and the drag — survive the switch.
     *
     * Nothing is logged here; this runs on every motion event of every drag.
     *
     * @param {number} x - pointer x, view-local
     */
    _trackEdgeFlip(x) {
        let zone = 0;
        if (x < EDGE_ZONE)
            zone = -1;
        else if (x > this.get_width() - EDGE_ZONE)
            zone = 1;

        if (zone === this._edgeZone)
            return;

        this._cancelEdgeFlip();
        this._edgeZone = zone;

        // Leaving the strip is what rearms it: one dwell, one flip. Without
        // that, holding the pointer on the edge would machine-gun through
        // every workspace.
        if (zone === 0) {
            this._edgeFiredZone = 0;
            return;
        }

        if (!this._onSwitchWorkspace || zone === this._edgeFiredZone)
            return;

        this._edgeTimeoutId = GLib.timeout_add_once(GLib.PRIORITY_DEFAULT,
            EDGE_DWELL_MILLISECONDS, () => {
                this._edgeTimeoutId = 0;
                this._edgeFiredZone = this._edgeZone;
                this._onSwitchWorkspace(this._edgeZone);
            });
    }

    _cancelEdgeFlip() {
        if (this._edgeTimeoutId) {
            GLib.Source.remove(this._edgeTimeoutId);
            this._edgeTimeoutId = 0;
        }
    }

    _resetEdgeFlip() {
        this._cancelEdgeFlip();
        this._edgeZone = 0;
        this._edgeFiredZone = 0;
    }

    _clearDropHighlight() {
        this._dropTargetIcon?.remove_css_class('drop-target');
        this._dropTargetIcon = null;
        this._resetEdgeFlip();
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
     * remember where each landed. The workspace the view is showing becomes
     * the workspace the icons belong to — which is how a drop after an
     * edge-flip moves an icon to another workspace.
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
            // Look in the full item list, not the visible icons: after an
            // edge-flip the dragged icons still belong to the workspace the
            // drag started on, so they are not drawn here any more.
            const item = this._allItems.find(candidate => candidate.uri === uri);
            if (!item)
                continue;

            let slot;
            do {
                slot = slotForIndex(start.column * rows + start.row + offset, rows);
                offset++;
            } while (occupied.has(slotKey(slot)));

            occupied.add(slotKey(slot));
            const origin = this._slotOrigin(slot);
            const position = {
                ws: this._activeWorkspace,
                x: this._monitor.x + origin.x,
                y: this._monitor.y + origin.y,
            };

            // Move the icon now, then persist. A metadata write is not a file
            // change, so the directory monitor never fires for it — waiting for
            // the model to come back would mean waiting forever, and the icon
            // would snap back to where it started.
            item.position = position;
            if (!item.special)
                writePosition(item.file, position.ws, position.x, position.y);
        }

        // Rebuild rather than re-layout: icons dropped after an edge-flip
        // have just joined this workspace and are not in the grid yet.
        this.setItems(this._directory, this._allItems);
    }

    _onTextDropped(text, x, y) {
        this._createDroppedFile(_('Dropped Text.txt'),
            new TextEncoder().encode(text), x, y);
    }

    _onTextureDropped(texture, x, y) {
        this._createDroppedFile(_('Dropped Image.png'),
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
        writePosition(file, this._activeWorkspace,
            this._monitor.x + origin.x, this._monitor.y + origin.y);
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
            this._menus.popupItemMenu(x, y);
        else
            this._menus.popupBackgroundMenu(x, y);
    }

    // --- clipboard ---

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
            if (!icon.item.special)
                clearPosition(icon.item.file);
        }

        this._layout();
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
            uniqueName(this._directory, _('Untitled Folder')));
    }

    /**
     * @param {string} source - "type" or "application"
     */
    setIconSource(source) {
        if (source === this._iconSource)
            return;

        this._iconSource = source;
        this._refreshApplicationIcons();
    }

    /** Re-resolve every icon. Nothing on disk changed, so nothing else will. */
    _refreshApplicationIcons() {
        for (const icon of this._icons)
            icon.setApplicationIcon(this._iconFor(icon.item));
    }

    /**
     * Which icon overrides the file type's own, if any.
     *
     * Under "type" the answer is usually none — the type icon is more use than
     * the application's, because it tells .stl from .obj where the application
     * icon would make every 3D model, and every text file, look identical. The
     * exception is a type the icon theme has nothing for at all: a generic
     * sheet of paper says less than the logo of the program that opens it.
     *
     * @param {object} item - a FileModel item
     * @returns {?Gio.Icon} an icon to use instead, or null to keep the type's
     */
    _iconFor(item) {
        if (item.special || item.isDirectory)
            return null;

        const application = defaultHandler(item)?.get_icon() ?? null;
        if (this._iconSource === 'application')
            return application;

        return this._themeHasIcon(item.icon) ? null : application;
    }

    _themeHasIcon(icon) {
        const display = this.get_display();
        if (!display || !icon)
            return true;

        return Gtk.IconTheme.get_for_display(display).has_gicon(icon);
    }
});

/**
 * @param {object} rect - a rectangle in view coordinates
 * @param {?Graphene.Rect} bounds - a widget's bounds, or null if unallocated
 * @returns {boolean} whether the two overlap at all
 */
function intersects(rect, bounds) {
    if (!bounds)
        return false;

    return rect.x < bounds.get_x() + bounds.get_width() &&
        bounds.get_x() < rect.x + rect.width &&
        rect.y < bounds.get_y() + bounds.get_height() &&
        bounds.get_y() < rect.y + rect.height;
}

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
 * @param {number} index - a linear slot index, counting down each column
 * @param {number} rows - the slots in one column
 * @returns {object} the slot at that index
 */
function slotForIndex(index, rows) {
    return {column: Math.floor(index / rows), row: index % rows};
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
