// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright 2026 Shahab Nedaei <ned.tabulov@gmail.com>
//
// Drag and drop, in and out of the desktop.
//
// This is the reason the renderer is a separate GTK process at all. Dragging a
// file from the desktop into Firefox's upload dialog, or out of Files onto the
// desktop, means being a real GTK drag source and a real GTK drop target; there
// is no way to do that from inside gnome-shell.
//
// What we offer when dragging out, in the order other applications look for it:
//
//   text/uri-list                 the universal answer. GDK's own deserialiser
//                                 turns it back into a GdkFileList, so GTK
//                                 applications get typed files for free.
//   x-special/gnome-copied-files  what Nautilus reads. Carries the *intent*
//                                 (copy or cut) in its first line, which
//                                 text/uri-list has no way to express.
//   text/plain                    for terminals and text editors.
//
// What we accept when dropping in: files (copied or moved through Nautilus),
// plain text, and images — the last two are written into ~/Desktop as new
// files, the way Files does it.

import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

export const URI_LIST = 'text/uri-list';
export const GNOME_COPIED_FILES = 'x-special/gnome-copied-files';

const DRAGGABLE_ACTIONS =
    Gdk.DragAction.COPY | Gdk.DragAction.MOVE | Gdk.DragAction.LINK;

/**
 * text/uri-list is CRLF-delimited by RFC 2483. Some readers tolerate bare LF;
 * not all of them do.
 *
 * @param {string[]} uris - the dragged files
 * @returns {GLib.Bytes} the encoded list
 */
export function encodeUriList(uris) {
    return new GLib.Bytes(
        new TextEncoder().encode(uris.map(uri => `${uri}\r\n`).join('')));
}

/**
 * @param {string[]} uris - the files
 * @param {string} intent - "copy" or "cut"
 * @returns {GLib.Bytes} the Nautilus clipboard/drag payload
 */
export function encodeGnomeCopiedFiles(uris, intent) {
    return new GLib.Bytes(
        new TextEncoder().encode([intent, ...uris].join('\n')));
}

/**
 * @param {string} text - a decoded x-special/gnome-copied-files payload
 * @returns {?object} {intent, uris}, or null if it is not that format
 */
export function decodeGnomeCopiedFiles(text) {
    const [intent, ...uris] = text.split('\n').map(line => line.trim()).filter(Boolean);
    if (intent !== 'copy' && intent !== 'cut')
        return null;

    return {intent, uris};
}

/**
 * The content a drag out of the desktop offers.
 *
 * @param {object[]} items - the dragged selection
 * @returns {Gdk.ContentProvider} every representation, best first
 */
export function contentForItems(items) {
    const uris = items.map(item => item.uri);

    return Gdk.ContentProvider.new_union([
        Gdk.ContentProvider.new_for_bytes(URI_LIST, encodeUriList(uris)),
        Gdk.ContentProvider.new_for_bytes(GNOME_COPIED_FILES,
            encodeGnomeCopiedFiles(uris, 'copy')),
        Gdk.ContentProvider.new_for_bytes('text/plain;charset=utf-8',
            new GLib.Bytes(new TextEncoder().encode(uris.join('\n')))),
    ]);
}

/**
 * Attach the desktop's drag source.
 *
 * It goes on the view, not on each icon, and hit-tests in `prepare`. A drag
 * source on the icon loses every time: the view's click gesture claims the
 * button press first, which cancels the child's gesture before it can reach
 * GTK's drag threshold. With both controllers on the same widget, GTK
 * arbitrates between them properly — the click wins a tap, the drag wins a
 * pull.
 *
 * @param {Gtk.Widget} view - the icon view
 * @param {object} params - callbacks into the view
 * @param {Function} params.onPrepareAt - (x, y) => {items, widget} or null
 * @param {Function} params.onBegin - called once the drag starts
 * @param {Function} params.onEnd - called after the drop
 * @returns {Gtk.DragSource} the controller, already attached
 */
export function addDragSource(view, {onPrepareAt, onBegin, onEnd}) {
    const source = new Gtk.DragSource({actions: DRAGGABLE_ACTIONS});
    let dragged = null;

    source.connect('prepare', (_source, x, y) => {
        dragged = onPrepareAt(x, y);
        return dragged ? contentForItems(dragged.items) : null;
    });

    source.connect('drag-begin', (_source, drag) => {
        if (!dragged)
            return;

        // Drag the icon's own picture, so what the user sees under the pointer
        // is the thing they picked up.
        const {widget} = dragged;
        const paintable = new Gtk.WidgetPaintable({widget});
        Gtk.DragIcon.get_for_drag(drag).set_child(new Gtk.Picture({paintable}));
        drag.set_hotspot(widget.get_width() / 2, widget.get_height() / 2);
        onBegin();
    });

    source.connect('drag-end', () => {
        dragged = null;
        onEnd();
    });

    view.add_controller(source);
    return source;
}

/**
 * Attach the desktop's drop target.
 *
 * @param {Gtk.Widget} view - the icon view
 * @param {object} params - callbacks into the view
 * @param {Function} params.onFiles - (files, x, y, action) => void
 * @param {Function} params.onText - (text, x, y) => void
 * @param {Function} params.onTexture - (texture, x, y) => void
 * @param {Function} params.onMotion - (x, y) => Gdk.DragAction to advertise
 * @param {Function} params.onLeave - called when the pointer leaves
 * @returns {Gtk.DropTarget} the controller, already attached
 */
export function addDropTarget(view, {onFiles, onText, onTexture, onMotion, onLeave}) {
    const target = new Gtk.DropTarget({
        actions: Gdk.DragAction.COPY | Gdk.DragAction.MOVE | Gdk.DragAction.LINK,
    });
    target.set_gtypes([Gdk.FileList.$gtype, Gdk.Texture.$gtype, GObject.TYPE_STRING]);

    // GTK insists on exactly one action here. Returning a mask of all three
    // makes it complain ("did not return a unique preferred action") on every
    // motion event and fall back to nothing.
    target.connect('motion', (_target, x, y) => {
        onMotion(x, y);

        const drop = target.get_current_drop();
        return drop ? preferredAction(drop) : Gdk.DragAction.COPY;
    });
    target.connect('leave', () => onLeave());

    target.connect('drop', (_target, value, x, y) => {
        const drop = target.get_current_drop();
        const action = drop ? preferredAction(drop) : Gdk.DragAction.COPY;

        if (value instanceof Gdk.FileList) {
            onFiles(value.get_files(), x, y, action);
            return true;
        }

        if (value instanceof Gdk.Texture) {
            onTexture(value, x, y);
            return true;
        }

        if (typeof value === 'string') {
            onText(value, x, y);
            return true;
        }

        return false;
    });

    view.add_controller(target);
    return target;
}

/**
 * Which of the offered actions to take.
 *
 * Copy is the safe default for something arriving from another application —
 * a move that surprises the user has destroyed the original. Holding Shift
 * asks for a move explicitly, which is the convention everywhere else.
 *
 * @param {Gdk.Drop} drop - the drop in progress
 * @returns {Gdk.DragAction} the action to perform
 */
export function preferredAction(drop) {
    const offered = drop.get_actions();
    const modifiers = modifierState(drop);

    const wantsMove = (modifiers & Gdk.ModifierType.SHIFT_MASK) !== 0;
    const wantsLink = (modifiers & Gdk.ModifierType.CONTROL_MASK) !== 0 &&
        (modifiers & Gdk.ModifierType.SHIFT_MASK) !== 0;

    if (wantsLink && (offered & Gdk.DragAction.LINK))
        return Gdk.DragAction.LINK;
    if (wantsMove && (offered & Gdk.DragAction.MOVE))
        return Gdk.DragAction.MOVE;
    if (offered & Gdk.DragAction.COPY)
        return Gdk.DragAction.COPY;
    if (offered & Gdk.DragAction.MOVE)
        return Gdk.DragAction.MOVE;

    return Gdk.DragAction.COPY;
}

/**
 * @param {Gdk.Drop} drop - the drop in progress
 * @returns {number} the keyboard modifiers held right now
 */
function modifierState(drop) {
    const device = drop.get_device();
    return device ? device.get_modifier_state() : 0;
}
