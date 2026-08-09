// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright 2026 Shahab Nedaei <ned.tabulov@gmail.com>
//
// Renaming, in a popover anchored to the icon.
//
// Files edits the label in place. On a Gtk.Fixed that would mean an entry that
// has to match the label's exact position, wrapping and ellipsis, and that grows
// out of its cell into its neighbours. A popover gets the same job done with the
// text visible and unclipped, and it dismisses itself on Escape or a click
// elsewhere for free.
//
// The extension is left out of the initial selection, the way every file manager
// does it, so typing replaces the name and keeps ".txt".

import Gdk from 'gi://Gdk';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {_} from './gettext.js';

export const RenamePopover = GObject.registerClass(
class RenamePopover extends Gtk.Popover {
    _init(params) {
        const {onCommit, ...popoverParams} = params;

        super._init({has_arrow: true, ...popoverParams});

        this._onCommit = onCommit;
        this._item = null;
        this.add_css_class('rename-popover');

        this._entry = new Gtk.Entry({width_chars: 24});
        this._entry.connect('activate', () => this._commit());

        const keys = new Gtk.EventControllerKey();
        keys.connect('key-pressed', (_controller, keyval) => {
            if (keyval !== Gdk.KEY_Escape)
                return Gdk.EVENT_PROPAGATE;

            this.popdown();
            return Gdk.EVENT_STOP;
        });
        this._entry.add_controller(keys);

        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
        box.append(new Gtk.Label({label: _('Rename'), xalign: 0, css_classes: ['heading']}));
        box.append(this._entry);
        this.set_child(box);
    }

    /**
     * @param {object} item - the item to rename
     * @param {Gdk.Rectangle} anchor - where to point, in the parent's coordinates
     */
    open(item, anchor) {
        this._item = item;
        this._entry.set_text(item.displayName);

        this.set_pointing_to(anchor);
        this.popup();
        this._entry.grab_focus();

        // After grab_focus, or the entry selects everything itself.
        const stem = stemLength(item.displayName, item.isDirectory);
        this._entry.select_region(0, stem);
    }

    _commit() {
        const name = this._entry.get_text().trim();
        this.popdown();

        if (name === '' || name === this._item.displayName)
            return;

        // A name with a separator in it would silently move the file somewhere
        // else, which is never what a rename means.
        if (name.includes('/')) {
            printerr('rename: refusing a name containing "/"');
            return;
        }

        this._onCommit(this._item, name);
    }
});

/**
 * @param {string} name - a file name
 * @param {boolean} isDirectory - whether it names a folder
 * @returns {number} how many characters to preselect
 */
function stemLength(name, isDirectory) {
    if (isDirectory)
        return name.length;

    // A leading dot is part of the name, not an extension.
    const dot = name.lastIndexOf('.');
    return dot > 0 ? dot : name.length;
}
