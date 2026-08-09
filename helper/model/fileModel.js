// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright 2026 Shahab Nedaei <ned.tabulov@gmail.com>
//
// What is on the desktop. Enumerates ~/Desktop asynchronously and re-reads it
// when anything changes.
//
// Re-reading the whole directory on every change is deliberate for now: a
// desktop holds tens of files, not thousands, and a full re-read cannot drift
// out of sync with reality the way incremental patching can. If that ever
// stops being true, this is the one place to change.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import '../core/promisify.js';
import {readPosition} from './iconPositions.js';

const ATTRIBUTES = [
    'standard::name',
    'standard::display-name',
    'standard::type',
    'standard::icon',
    'standard::is-hidden',
    'standard::is-backup',
    'standard::is-symlink',
    'standard::content-type',
    'thumbnail::path',
    'thumbnail::is-valid',
    'access::can-execute',
    'access::can-write',
    'time::modified',
    'metadata::nautilus-icon-position',
].join(',');

// File monitors report a burst of events for one logical change (write, then
// attribute change, then changes-done-hint). Wait for the burst to end.
const SETTLE_MILLISECONDS = 150;

export class FileModel {
    /**
     * @param {object} params - configuration
     * @param {Gio.File} params.directory - the directory to show
     * @param {Function} params.onChanged - called with the new item list
     */
    constructor({directory, onChanged}) {
        this._directory = directory;
        this._onChanged = onChanged;
        this._items = [];
        this._showHidden = false;

        this._cancellable = new Gio.Cancellable();
        this._settleId = 0;
        this._monitor = null;
        this._readGeneration = 0;
    }

    /** @returns {object[]} the current items, already sorted */
    get items() {
        return this._items;
    }

    start() {
        // A missing file monitor costs live updates, not the desktop. Some
        // sandboxes deny inotify outright, and some filesystems cannot be
        // watched at all; in both cases showing a static listing beats
        // showing nothing.
        try {
            this._monitor = this._directory.monitor_directory(
                Gio.FileMonitorFlags.WATCH_MOVES, this._cancellable);
            this._monitorId = this._monitor.connect('changed', () => this._queueRead());
        } catch (error) {
            printerr(`fileModel: no live updates (${error.message})`);
        }

        this._read();
    }

    destroy() {
        if (this._settleId) {
            GLib.Source.remove(this._settleId);
            this._settleId = 0;
        }

        this._cancellable.cancel();

        if (this._monitor) {
            this._monitor.disconnect(this._monitorId);
            this._monitor.cancel();
            this._monitor = null;
        }
    }

    /**
     * @param {boolean} showHidden - whether dotfiles are listed
     */
    setShowHidden(showHidden) {
        if (this._showHidden === showHidden)
            return;

        this._showHidden = showHidden;
        this._read();
    }

    _queueRead() {
        if (this._settleId)
            GLib.Source.remove(this._settleId);

        this._settleId = GLib.timeout_add_once(GLib.PRIORITY_DEFAULT,
            SETTLE_MILLISECONDS, () => {
                this._settleId = 0;
                this._read();
            });
    }

    async _read() {
        // Reads overlap: the settle timer and setShowHidden do not wait for
        // each other, and an older enumeration finishing last would restore
        // stale state. Only the newest read may publish.
        const generation = ++this._readGeneration;

        let infos;
        try {
            infos = await enumerate(this._directory, this._cancellable);
        } catch (error) {
            if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                printerr(`fileModel: cannot read the desktop: ${error.message}`);
            return;
        }

        if (generation !== this._readGeneration)
            return;

        this._items = infos
            .filter(info => this._showHidden || !isHidden(info))
            .map(info => this._toItem(info))
            .sort(compareItems);

        this._onChanged(this._items);
    }

    _toItem(info) {
        const file = this._directory.get_child(info.get_name());
        const thumbnail = info.get_attribute_byte_string('thumbnail::path');

        return {
            file,
            uri: file.get_uri(),
            name: info.get_name(),
            displayName: info.get_display_name(),
            icon: info.get_icon(),
            contentType: info.get_content_type(),
            isDirectory: info.get_file_type() === Gio.FileType.DIRECTORY,
            isSymlink: info.get_is_symlink(),
            isExecutable: info.get_attribute_boolean('access::can-execute'),
            canWrite: info.get_attribute_boolean('access::can-write'),
            // The thumbnail spec keys every entry on the source file's mtime,
            // so a stale thumbnail is detected rather than shown.
            modified: info.get_attribute_uint64('time::modified'),
            thumbnailPath: info.get_attribute_boolean('thumbnail::is-valid')
                ? thumbnail : null,
            // null until the user drags the icon somewhere.
            position: readPosition(info),
        };
    }
}

/**
 * @param {Gio.File} directory - directory to list
 * @param {Gio.Cancellable} cancellable - cancels the walk
 * @returns {Promise<Gio.FileInfo[]>} every entry, in whatever order arrives
 */
async function enumerate(directory, cancellable) {
    const enumerator = await directory.enumerate_children_async(
        ATTRIBUTES, Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);

    const infos = [];
    for (;;) {
        const batch = await enumerator.next_files_async(
            64, GLib.PRIORITY_DEFAULT, cancellable);
        if (batch.length === 0)
            return infos;

        infos.push(...batch);
    }
}

/**
 * @param {Gio.FileInfo} info - an entry
 * @returns {boolean} whether the desktop should hide it by default
 */
function isHidden(info) {
    return info.get_is_hidden() || info.get_attribute_boolean('standard::is-backup');
}

/**
 * Folders first, then by display name — the order Files uses.
 *
 * @param {object} a - an item
 * @param {object} b - another item
 * @returns {number} sort order
 */
function compareItems(a, b) {
    if (a.isDirectory !== b.isDirectory)
        return a.isDirectory ? -1 : 1;

    return a.displayName.localeCompare(b.displayName, undefined,
        {numeric: true, sensitivity: 'base'});
}
