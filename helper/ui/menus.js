// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright 2026 Shahab Nedaei <ned.tabulov@gmail.com>
//
// The icon view's menus: the action group both menus share, the background
// menu, the per-click item menu, and the rename popover.
//
// What the entries *do* to the selection — cut, copy, trash, tidy — stays on
// the view, because the keyboard reaches the same operations. What only a
// menu can reach — eject, wallpaper, trusting a launcher, Open With — lives
// here.

import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import {_} from '../core/gettext.js';
import {actionAvailability, buildItemMenu, launchContext} from './itemMenu.js';
import {OpenWithDialog} from './openWithDialog.js';
import {RenamePopover} from './renamePopover.js';
import {openTerminal, runInTerminal} from '../ops/terminal.js';

export class Menus {
    /**
     * @param {IconView} view - the view these menus act on
     */
    constructor(view) {
        this._view = view;

        this._rename = new RenamePopover({
            onCommit: (item, name) => view._operations.rename(item.uri, name),
        });
        this._rename.set_parent(view);

        this._actions = new Gio.SimpleActionGroup();
        for (const [name, activate] of Object.entries(this._actionHandlers())) {
            const action = new Gio.SimpleAction({name});
            action.connect('activate', activate);
            this._actions.add_action(action);
        }
        view.insert_action_group('desktop', this._actions);

        // The background menu is the same whatever is under the pointer, so it
        // is built once. The item menu is built per click; see popupItemMenu.
        const background = new Gio.Menu();

        const create = new Gio.Menu();
        create.append(_('New Folder'), 'desktop.new-folder');
        background.append_section(null, create);

        // Five entries, and each one is the only way to reach what it does.
        // Dropped: Select All and Undo (Ctrl+A, Ctrl+Z), Open Desktop in Files
        // (the desktop already is that folder), and Display Settings (nothing
        // to do with the desktop).
        const edit = new Gio.Menu();
        edit.append(_('Paste'), 'desktop.paste');
        background.append_section(null, edit);

        const open = new Gio.Menu();
        open.append(_('Open in Terminal'), 'desktop.open-terminal-here');
        open.append(_('Tidy Up Icons'), 'desktop.tidy-up');
        background.append_section(null, open);

        const settings = new Gio.Menu();
        settings.append(_('Change Background…'), 'desktop.change-background');
        background.append_section(null, settings);

        this._menu = new Gtk.PopoverMenu({has_arrow: false, halign: Gtk.Align.START});
        this._menu.set_parent(view);
        this._backgroundModel = background;
    }

    /** Unparents the popovers, which would otherwise outlive the view. */
    destroy() {
        this._rename.unparent();
        this._menu.unparent();
    }

    popupItemMenu(x, y) {
        const items = this._view.selectedItems;
        const available = actionAvailability(items);
        for (const [name, enabled] of Object.entries(available))
            this._actions.lookup_action(name)?.set_enabled(enabled);

        this._popup(buildItemMenu(items), x, y);
    }

    popupBackgroundMenu(x, y) {
        this._popup(this._backgroundModel, x, y);
    }

    _popup(model, x, y) {
        this._menu.set_menu_model(model);
        this._menu.set_pointing_to(new Gdk.Rectangle({x, y, width: 1, height: 1}));
        this._menu.popup();
    }

    renameSelection() {
        const [item] = this._view.selectedItems;
        if (!item)
            return;

        const icon = this._view._icons.find(candidate => candidate.item.uri === item.uri);
        const bounds = icon?.compute_bounds(this._view)[1];
        if (!bounds)
            return;

        this._rename.open(item, new Gdk.Rectangle({
            x: bounds.get_x(),
            y: bounds.get_y(),
            width: bounds.get_width(),
            height: bounds.get_height(),
        }));
    }

    _actionHandlers() {
        const view = this._view;
        return {
            'open': () => view._onOpen(view.selectedItems),
            'open-with': () => this._openWith(),
            'open-terminal': () => this._openTerminalInSelection(),
            'rename': () => this.renameSelection(),
            'empty-trash': () => view._operations.emptyTrash(),
            'run': () => this._runSelection(),
            'eject': () => this._ejectSelection(),
            'cut': () => view._toClipboard('cut'),
            'copy': () => view._toClipboard('copy'),
            'paste': () => view._paste(),
            'undo': () => view._operations.undo(),
            'tidy-up': () => view._tidyUp(),
            'set-background': () => this._setBackground(),
            'allow-launching': () => this._allowLaunching(),
            'properties': () => view._operations.showProperties(view._selectedUris()),
            'trash': () => view._trashSelection(),
            'select-all': () => view._selectAll(),
            'new-folder': () => view._newFolder(),
            'open-terminal-here': () => openTerminal(view._directory),
            'change-background': () => launchSettings('background'),
        };
    }

    _runSelection() {
        const [item] = this._view.selectedItems;
        if (item)
            runInTerminal(item.file);
    }

    _ejectSelection() {
        const [item] = this._view.selectedItems;
        const {mount} = item ?? {};
        if (!mount)
            return;

        // Eject is for removable media; unmount is the rest. Asking for the
        // wrong one fails, so pick by what the mount says it can do.
        const operation = new Gtk.MountOperation({parent: this._view.get_root()});
        if (mount.can_eject()) {
            mount.eject_with_operation(Gio.MountUnmountFlags.NONE, operation, null,
                (source, result) => reportUnmount(source, () => source.eject_with_operation_finish(result)));
        } else {
            mount.unmount_with_operation(Gio.MountUnmountFlags.NONE, operation, null,
                (source, result) => reportUnmount(source, () => source.unmount_with_operation_finish(result)));
        }
    }

    _openTerminalInSelection() {
        const [item] = this._view.selectedItems;
        if (item?.isDirectory)
            openTerminal(item.file);
    }

    _setBackground() {
        const [item] = this._view.selectedItems;
        if (!item)
            return;

        // Both keys, or the wallpaper only changes in one of light and dark.
        const settings = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
        settings.set_string('picture-uri', item.uri);
        settings.set_string('picture-uri-dark', item.uri);
    }

    _allowLaunching() {
        const [item] = this._view.selectedItems;
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

    _openWith() {
        const [item] = this._view.selectedItems;
        if (!item)
            return;

        const dialog = new OpenWithDialog({
            item,
            application: this._view.get_root()?.application ?? null,
            onChoose: (application, alwaysUse) =>
                this._launchWith(item, application, alwaysUse),
        });
        dialog.present();
    }

    /**
     * @param {object} item - what to open
     * @param {Gio.AppInfo} application - what to open it with
     * @param {boolean} alwaysUse - whether to make it the default for the type
     */
    _launchWith(item, application, alwaysUse) {
        const type = item.isDirectory ? 'inode/directory' : item.contentType;

        if (alwaysUse) {
            try {
                application.set_as_default_for_type(type);
                // Nothing about the file changed, so no monitor will fire and
                // nothing will redraw. Repaint the badges by hand.
                this._view._refreshApplicationIcons();
            } catch (error) {
                printerr(`iconView: cannot make ${application.get_id()} the default: ${error.message}`);
            }
        }

        const context = launchContext(this._view.get_display());
        try {
            application.launch_uris([item.uri], context);
        } catch (error) {
            printerr(`iconView: cannot open with ${application.get_id()}: ${error.message}`);
        }
    }
}

/**
 * @param {Gio.Mount} mount - the mount being released
 * @param {Function} finish - the matching finish call
 */
function reportUnmount(mount, finish) {
    try {
        finish();
    } catch (error) {
        if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.FAILED_HANDLED))
            printerr(`iconView: cannot eject ${mount.get_name()}: ${error.message}`);
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
