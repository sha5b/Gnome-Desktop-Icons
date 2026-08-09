// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright 2026 Shahab Nedaei <ned.tabulov@gmail.com>
//
// Cut, Copy and Paste, in the format Files understands.
//
// The clipboard carries the same two things a drag does: `text/uri-list` for
// everyone, and `x-special/gnome-copied-files` for Nautilus. Only the second
// can say whether this was a copy or a cut, which is why both are offered —
// copy something in Files, paste it on the desktop, and the intent survives.

import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {decodeGnomeCopiedFiles, encodeGnomeCopiedFiles, encodeUriList} from './dragAndDrop.js';

const GNOME_COPIED_FILES = 'x-special/gnome-copied-files';
const URI_LIST = 'text/uri-list';

/**
 * @param {Gdk.Clipboard} clipboard - the display's clipboard
 * @param {object[]} items - what to put on it
 * @param {string} intent - "copy" or "cut"
 */
export function setClipboard(clipboard, items, intent) {
    const uris = items.map(item => item.uri);

    clipboard.set_content(Gdk.ContentProvider.new_union([
        Gdk.ContentProvider.new_for_bytes(GNOME_COPIED_FILES,
            encodeGnomeCopiedFiles(uris, intent)),
        Gdk.ContentProvider.new_for_bytes(URI_LIST, encodeUriList(uris)),
        Gdk.ContentProvider.new_for_bytes('text/plain;charset=utf-8',
            new GLib.Bytes(new TextEncoder().encode(uris.join('\n')))),
    ]));
}

/**
 * Read the clipboard and act on it.
 *
 * @param {Gdk.Clipboard} clipboard - the display's clipboard
 * @param {Function} onFiles - (uris, intent) => void, intent is "copy" or "cut"
 */
export function pasteFromClipboard(clipboard, onFiles) {
    const formats = clipboard.get_formats();

    // Ask for the Nautilus format first: it is the only one that says whether
    // the user pressed Ctrl+C or Ctrl+X.
    if (formats.contain_mime_type(GNOME_COPIED_FILES)) {
        readText(clipboard, GNOME_COPIED_FILES, text => {
            const decoded = decodeGnomeCopiedFiles(text);
            if (decoded)
                onFiles(decoded.uris, decoded.intent);
        });
        return;
    }

    if (formats.contain_mime_type(URI_LIST)) {
        readText(clipboard, URI_LIST, text => {
            const uris = text.split(/\r?\n/).map(line => line.trim())
                .filter(line => line && !line.startsWith('#'));
            if (uris.length > 0)
                onFiles(uris, 'copy');
        });
    }
}

/**
 * @param {Gdk.Clipboard} clipboard - the display's clipboard
 * @param {string} mimeType - what to ask for
 * @param {Function} onText - called with the decoded payload
 */
function readText(clipboard, mimeType, onText) {
    clipboard.read_async([mimeType], GLib.PRIORITY_DEFAULT, null,
        (source, result) => {
            let stream;
            try {
                [stream] = source.read_finish(result);
            } catch (error) {
                printerr(`clipboard: cannot read ${mimeType}: ${error.message}`);
                return;
            }

            readAll(stream, onText);
        });
}

/**
 * @param {Gio.InputStream} stream - the clipboard's data
 * @param {Function} onText - called with the whole payload as a string
 */
function readAll(stream, onText) {
    const output = Gio.MemoryOutputStream.new_resizable();

    output.splice_async(stream,
        Gio.OutputStreamSpliceFlags.CLOSE_SOURCE | Gio.OutputStreamSpliceFlags.CLOSE_TARGET,
        GLib.PRIORITY_DEFAULT, null,
        (source, result) => {
            try {
                source.splice_finish(result);
            } catch (error) {
                printerr(`clipboard: cannot drain the stream: ${error.message}`);
                return;
            }

            const bytes = output.steal_as_bytes();
            onText(new TextDecoder().decode(bytes.get_data()));
        });
}
