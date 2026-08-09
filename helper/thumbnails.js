// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright 2026 Shahab Nedaei <ned.tabulov@gmail.com>
//
// Thumbnails, via the same shared cache Nautilus uses.
//
// Three-step path for each file. If Gio already reported a valid thumbnail in
// `thumbnail::path`, use it. Otherwise ask the shared cache in
// ~/.cache/thumbnails. Only if both miss do we generate one, and then we write
// it back so Files and every other GNOME app gets it for free.
//
// Failures are recorded as failed thumbnails, exactly as the spec requires, so
// a file that cannot be thumbnailed is not retried on every redraw.

import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GnomeDesktop from 'gi://GnomeDesktop?version=4.0';

import './promisify.js';

// One generation at a time. A desktop full of videos would otherwise fork a
// thumbnailer per file at once and make the whole session stutter.
const MAX_CONCURRENT = 2;

export class ThumbnailLoader {
    /**
     * @param {GnomeDesktop.DesktopThumbnailSize} size - cache bucket to use
     */
    constructor(size = GnomeDesktop.DesktopThumbnailSize.LARGE) {
        this._factory = GnomeDesktop.DesktopThumbnailFactory.new(size);
        this._cancellable = new Gio.Cancellable();
        this._queue = [];
        this._running = 0;
    }

    destroy() {
        this._cancellable.cancel();
        this._queue = [];
    }

    /**
     * @param {object} item - a FileModel item
     * @param {Function} onReady - called with a Gdk.Texture, possibly never
     */
    request(item, onReady) {
        const existing = item.thumbnailPath ?? this._factory.lookup(item.uri, item.modified);
        if (existing) {
            const texture = textureFromPath(existing);
            if (texture)
                onReady(texture);
            return;
        }

        if (this._factory.has_valid_failed_thumbnail(item.uri, item.modified))
            return;
        if (!this._factory.can_thumbnail(item.uri, item.contentType, item.modified))
            return;

        this._queue.push({item, onReady});
        this._pump();
    }

    _pump() {
        while (this._running < MAX_CONCURRENT && this._queue.length > 0) {
            const job = this._queue.shift();
            this._running++;
            this._generate(job).catch(logUnexpected).finally(() => {
                this._running--;
                this._pump();
            });
        }
    }

    async _generate({item, onReady}) {
        let pixbuf;
        try {
            pixbuf = await this._factory.generate_thumbnail_async(
                item.uri, item.contentType, this._cancellable);
        } catch (error) {
            if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;

            // Remember the failure so the next redraw does not try again.
            await this._factory.create_failed_thumbnail_async(
                item.uri, item.modified, this._cancellable).catch(() => {});
            return;
        }

        // Hand the picture over before writing to disk: the user should not
        // wait on the cache write.
        onReady(Gdk.Texture.new_for_pixbuf(pixbuf));

        await this._factory.save_thumbnail_async(
            pixbuf, item.uri, item.modified, this._cancellable).catch(() => {});
    }
}

/**
 * @param {string} path - a file in the thumbnail cache
 * @returns {?Gdk.Texture} the picture, or null if the cache entry is broken
 */
function textureFromPath(path) {
    try {
        return Gdk.Texture.new_from_file(Gio.File.new_for_path(path));
    } catch (error) {
        printerr(`thumbnails: cannot load ${path}: ${error.message}`);
        return null;
    }
}

/**
 * @param {Error} error - anything the queue did not expect
 */
function logUnexpected(error) {
    printerr(`thumbnails: ${error.message}`);
}
