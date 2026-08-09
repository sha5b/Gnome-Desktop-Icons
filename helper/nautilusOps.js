// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright 2026 Shahab Nedaei <ned.tabulov@gmail.com>
//
// File operations, handed to Nautilus.
//
// Nautilus cannot draw the desktop any more, but it is still the file manager.
// Routing operations through it gives us its progress windows, its conflict and
// permission dialogs, its Properties window and — the part that matters most —
// a shared undo stack, so Ctrl+Z in Files undoes what was done on the desktop.
//
// Two interfaces are used:
//   org.gnome.Nautilus.FileOperations2  copy, move, trash, delete, create folder
//   org.freedesktop.FileManager1        reveal a file, show its properties
//
// Both are D-Bus activatable, so Nautilus starts on demand. Trash and create
// folder fall back to plain Gio when the call fails, because those two are how
// a user destroys and makes things and they must work even with no Nautilus
// installed. The rest have no sensible fallback and report instead.
//
// Every FileOperations2 method takes a trailing platform-data dictionary
// carrying the parent window and startup id. We have neither to offer — the
// desktop is not a window a dialog can sensibly be modal to — so it is empty
// and Nautilus parents its dialogs itself.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import './promisify.js';

const OPERATIONS = {
    name: 'org.gnome.Nautilus',
    path: '/org/gnome/Nautilus/FileOperations2',
    iface: 'org.gnome.Nautilus.FileOperations2',
};

const MANAGER = {
    name: 'org.freedesktop.FileManager1',
    path: '/org/freedesktop/FileManager1',
    iface: 'org.freedesktop.FileManager1',
};

export class NautilusOps {
    constructor() {
        this._bus = Gio.DBus.session;
        this._cancellable = new Gio.Cancellable();
    }

    destroy() {
        this._cancellable.cancel();
    }

    /**
     * @param {string[]} uris - files to move to the wastebasket
     */
    async trash(uris) {
        try {
            await this._call(OPERATIONS, 'TrashURIs',
                new GLib.Variant('(asa{sv})', [uris, {}]));
        } catch (error) {
            reportFallback('trash', error);
            for (const uri of uris) {
                await Gio.File.new_for_uri(uri)
                    .trash_async(GLib.PRIORITY_DEFAULT, this._cancellable)
                    .catch(fallbackError =>
                        printerr(`nautilusOps: cannot trash ${uri}: ${fallbackError.message}`));
            }
        }
    }

    /**
     * @param {string} parentUri - directory to create the folder in
     * @param {string} name - the new folder's name
     */
    async createFolder(parentUri, name) {
        try {
            await this._call(OPERATIONS, 'CreateFolder',
                new GLib.Variant('(ssa{sv})', [parentUri, name, {}]));
        } catch (error) {
            reportFallback('create folder', error);
            await Gio.File.new_for_uri(parentUri).get_child(name)
                .make_directory_async(GLib.PRIORITY_DEFAULT, this._cancellable)
                .catch(fallbackError =>
                    printerr(`nautilusOps: cannot create folder: ${fallbackError.message}`));
        }
    }

    /**
     * @param {string[]} uris - files to copy
     * @param {string} destinationUri - where to put them
     */
    async copy(uris, destinationUri) {
        await this._callReporting(OPERATIONS, 'CopyURIs',
            new GLib.Variant('(assa{sv})', [uris, destinationUri, {}]));
    }

    /**
     * @param {string[]} uris - files to move
     * @param {string} destinationUri - where to put them
     */
    async move(uris, destinationUri) {
        await this._callReporting(OPERATIONS, 'MoveURIs',
            new GLib.Variant('(assa{sv})', [uris, destinationUri, {}]));
    }

    /**
     * @param {string} uri - file to rename
     * @param {string} newName - its new name
     */
    async rename(uri, newName) {
        await this._callReporting(OPERATIONS, 'RenameURI',
            new GLib.Variant('(ssa{sv})', [uri, newName, {}]));
    }

    /** Empty the wastebasket, with Nautilus's confirmation dialog. */
    async emptyTrash() {
        await this._callReporting(OPERATIONS, 'EmptyTrash',
            new GLib.Variant('(ba{sv})', [true, {}]));
    }

    /** Reverse the last operation, on the stack shared with Files. */
    async undo() {
        await this._callReporting(OPERATIONS, 'Undo', new GLib.Variant('(a{sv})', [{}]));
    }

    /**
     * @param {string[]} uris - files whose Properties window to open
     */
    async showProperties(uris) {
        await this._callReporting(MANAGER, 'ShowItemProperties',
            new GLib.Variant('(ass)', [uris, '']));
    }

    _call(target, method, parameters) {
        return this._bus.call(target.name, target.path, target.iface, method,
            parameters, null, Gio.DBusCallFlags.NONE, -1, this._cancellable);
    }

    async _callReporting(target, method, parameters) {
        try {
            await this._call(target, method, parameters);
        } catch (error) {
            printerr(`nautilusOps: ${method} failed: ${error.message}`);
        }
    }
}

/**
 * @param {string} what - the operation that could not reach Nautilus
 * @param {Error} error - why
 */
function reportFallback(what, error) {
    printerr(`nautilusOps: ${what} via Nautilus failed (${error.message}); using Gio`);
}
