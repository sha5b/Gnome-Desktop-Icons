// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright 2026 Shahab Nedaei <ned.tabulov@gmail.com>
//
// The icon view's keyboard: shortcuts, arrow-key navigation and type-ahead.
//
// The controller is a plain Gtk.EventControllerKey on the view, so focus rules
// stay exactly as they were; everything the keys *do* is a method on the view
// or its menus. What this class owns itself is the type-ahead state — the
// accumulated prefix and the timeout that forgets it.

import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

// How long a type-ahead search stays open after the last keystroke.
const TYPE_AHEAD_MILLISECONDS = 1000;

export class Keyboard {
    /**
     * @param {IconView} view - the view whose keys this handles
     */
    constructor(view) {
        this._view = view;
        this._typeAhead = '';
        this._typeAheadId = 0;

        const controller = new Gtk.EventControllerKey();
        controller.connect('key-pressed', (_controller, keyval, _code, state) =>
            this._onKeyPressed(keyval, state));
        view.add_controller(controller);
    }

    /** Removes the type-ahead timeout, if one is pending. */
    destroy() {
        if (this._typeAheadId) {
            GLib.Source.remove(this._typeAheadId);
            this._typeAheadId = 0;
        }
    }

    _onKeyPressed(keyval, state) {
        const control = (state & Gdk.ModifierType.CONTROL_MASK) !== 0;
        const view = this._view;

        switch (keyval) {
        case Gdk.KEY_a:
            if (!control)
                return Gdk.EVENT_PROPAGATE;
            view._selectAll();
            return Gdk.EVENT_STOP;
        case Gdk.KEY_x:
            if (!control)
                return Gdk.EVENT_PROPAGATE;
            view._toClipboard('cut');
            return Gdk.EVENT_STOP;
        case Gdk.KEY_c:
            if (!control)
                return Gdk.EVENT_PROPAGATE;
            view._toClipboard('copy');
            return Gdk.EVENT_STOP;
        case Gdk.KEY_v:
            if (!control)
                return Gdk.EVENT_PROPAGATE;
            view._paste();
            return Gdk.EVENT_STOP;
        case Gdk.KEY_z:
            if (!control)
                return Gdk.EVENT_PROPAGATE;
            view._operations.undo();
            return Gdk.EVENT_STOP;
        case Gdk.KEY_Return:
        case Gdk.KEY_KP_Enter:
            view._onOpen(view.selectedItems);
            return Gdk.EVENT_STOP;
        case Gdk.KEY_Delete:
        case Gdk.KEY_KP_Delete:
            view._trashSelection();
            return Gdk.EVENT_STOP;
        case Gdk.KEY_F2:
            view._menus.renameSelection();
            return Gdk.EVENT_STOP;
        case Gdk.KEY_Escape:
            view._selectOnly(null);
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
        const match = this._view._icons.find(icon =>
            icon.item.displayName.toLowerCase().startsWith(prefix));
        if (match)
            this._view._selectOnly(match.item);

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
        const view = this._view;
        if (view._icons.length === 0)
            return;

        const {rows} = view._grid();
        const current = view._icons.findIndex(icon => view._selection.has(icon.item.uri));
        const step = {
            [Gdk.KEY_Up]: -1,
            [Gdk.KEY_Down]: 1,
            [Gdk.KEY_Left]: -rows,
            [Gdk.KEY_Right]: rows,
        }[keyval];

        const next = Math.min(view._icons.length - 1,
            Math.max(0, (current < 0 ? 0 : current + step)));
        view._selectOnly(view._icons[next].item);
    }
}
