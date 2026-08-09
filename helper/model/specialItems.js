// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright 2026 Shahab Nedaei <ned.tabulov@gmail.com>
//
// The things on the desktop that are not files in ~/Desktop: Home, the
// wastebasket, and mounted volumes.
//
// They look like ordinary items to the view — same shape of object, same icon,
// same label — but they carry `special`, which is how everything downstream
// knows not to offer to rename or trash them. Deleting the wastebasket is not a
// thing, and neither is renaming a USB stick from here.
//
// The wastebasket's icon has to say whether it is empty, so it is monitored:
// `trash:///` is a real location with a real file monitor, and emptying it from
// anywhere updates the icon here.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {_} from '../core/gettext.js';

export class SpecialItems {
    /**
     * @param {Function} onChanged - called when the list changes
     */
    constructor(onChanged) {
        this._onChanged = onChanged;
        this._show = {home: true, trash: true, volumes: true};
        this._trashEmpty = true;

        this._volumeMonitor = Gio.VolumeMonitor.get();
        this._volumeIds = [
            'mount-added', 'mount-removed', 'mount-changed',
        ].map(signal => this._volumeMonitor.connect(signal, () => this._onChanged()));

        this._trash = Gio.File.new_for_uri('trash:///');
        this._trashMonitor = null;
        this._watchTrash();
        this._refreshTrash();
    }

    /**
     * @param {object} show - which categories to include
     */
    setVisibility(show) {
        this._show = {...this._show, ...show};
        this._onChanged();
    }

    destroy() {
        for (const id of this._volumeIds)
            this._volumeMonitor.disconnect(id);
        this._volumeIds = [];

        if (this._trashMonitor) {
            this._trashMonitor.disconnect(this._trashMonitorId);
            this._trashMonitor.cancel();
            this._trashMonitor = null;
        }

        this._onChanged = null;
    }

    /** @returns {object[]} the special items, in the order they should appear */
    list() {
        const items = [];

        if (this._show.home)
            items.push(this._homeItem());
        if (this._show.trash)
            items.push(this._trashItem());
        if (this._show.volumes)
            items.push(...this._volumeItems());

        return items;
    }

    _homeItem() {
        const file = Gio.File.new_for_path(GLib.get_home_dir());
        return {
            ...baseItem(file),
            displayName: _('Home'),
            icon: new Gio.ThemedIcon({name: 'user-home'}),
            isDirectory: true,
            special: 'home',
        };
    }

    _trashItem() {
        return {
            ...baseItem(this._trash),
            displayName: _('Wastebasket'),
            icon: new Gio.ThemedIcon({
                name: this._trashEmpty ? 'user-trash' : 'user-trash-full',
            }),
            isDirectory: true,
            special: 'trash',
            trashEmpty: this._trashEmpty,
        };
    }

    _volumeItems() {
        return this._volumeMonitor.get_mounts()
            // A mount the user is not meant to see is not desktop furniture.
            .filter(mount => !mount.is_shadowed())
            .map(mount => ({
                ...baseItem(mount.get_root()),
                displayName: mount.get_name(),
                icon: mount.get_icon(),
                isDirectory: true,
                special: 'volume',
                canEject: mount.can_eject() || mount.can_unmount(),
                mount,
            }));
    }

    _watchTrash() {
        try {
            this._trashMonitor = this._trash.monitor_directory(
                Gio.FileMonitorFlags.NONE, null);
            this._trashMonitorId = this._trashMonitor.connect('changed', () => {
                this._refreshTrash();
            });
        } catch (error) {
            printerr(`specialItems: cannot watch the wastebasket (${error.message})`);
        }
    }

    _refreshTrash() {
        this._trash.query_info_async(Gio.FILE_ATTRIBUTE_TRASH_ITEM_COUNT,
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, null,
            (file, result) => {
                let empty = true;
                try {
                    empty = file.query_info_finish(result)
                        .get_attribute_uint32(Gio.FILE_ATTRIBUTE_TRASH_ITEM_COUNT) === 0;
                } catch (error) {
                    printerr(`specialItems: cannot count the wastebasket: ${error.message}`);
                }

                if (empty === this._trashEmpty)
                    return;

                this._trashEmpty = empty;
                this._onChanged();
            });
    }
}

/**
 * The fields every item is expected to have, so a special item can go through
 * the same code paths as a real file without special-casing at every step.
 *
 * @param {Gio.File} file - what the item points at
 * @returns {object} the common half of an item
 */
function baseItem(file) {
    return {
        file,
        uri: file.get_uri(),
        name: file.get_basename() ?? file.get_uri(),
        contentType: 'inode/directory',
        isSymlink: false,
        isExecutable: false,
        canWrite: false,
        modified: 0,
        thumbnailPath: null,
        position: null,
    };
}
