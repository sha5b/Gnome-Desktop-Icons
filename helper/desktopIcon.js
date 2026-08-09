// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright 2026 Shahab Nedaei <ned.tabulov@gmail.com>
//
// One icon on the desktop: a picture over a label.
//
// The picture is whatever Gio says it is. `Gio.FileInfo.get_icon()` returns a
// themed icon built from the file's content type, resolved through the active
// GTK icon theme — the same lookup Files does, so a .mp4 gets the video icon
// and a .stl gets the model icon without us keeping a table of our own.
// A thumbnail replaces it later if one can be made.
//
// Where a file has no thumbnail, the *application* that opens it wins over the
// type icon. GNOME derives a file's icon from its type alone, which means
// changing the default application changes nothing you can see. Here it does:
// point a .csv at LibreOffice Calc and it looks like a Calc document, point it
// at the text editor and it looks like a text document. A real thumbnail always
// wins — a photograph of the file's contents says more than either.

import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

const LABEL_LINES = 2;

export const DesktopIcon = GObject.registerClass(
class DesktopIcon extends Gtk.Box {
    _init(params) {
        const {item, iconSize, cellWidth, appIcon, ...boxParams} = params;

        super._init({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            ...boxParams,
        });

        this._item = item;
        this.add_css_class('desktop-icon');
        this.set_size_request(cellWidth, -1);

        this._image = new Gtk.Image({
            gicon: item.icon,
            pixel_size: iconSize,
            halign: Gtk.Align.CENTER,
        });
        this._image.add_css_class('desktop-icon-image');
        this._hasThumbnail = false;
        this.setApplicationIcon(appIcon ?? null);

        this._label = new Gtk.Label({
            label: item.displayName,
            justify: Gtk.Justification.CENTER,
            wrap: true,
            wrap_mode: Pango.WrapMode.WORD_CHAR,
            lines: LABEL_LINES,
            ellipsize: Pango.EllipsizeMode.END,
            max_width_chars: 1, // let the cell's size request drive the width
            halign: Gtk.Align.CENTER,
        });
        this._label.add_css_class('desktop-icon-label');

        this.append(this._image);
        this.append(this._label);

        this._applyEmblems();

        // Screen readers and the keyboard both need a name for this thing.
        this.update_property(
            [Gtk.AccessibleProperty.LABEL], [this._accessibleName()]);
    }

    /** @returns {object} the file this icon stands for */
    get item() {
        return this._item;
    }

    /**
     * @param {boolean} selected - whether to draw the selection highlight
     */
    setSelected(selected) {
        if (selected)
            this.add_css_class('selected');
        else
            this.remove_css_class('selected');

        // SELECTED is a tristate, not a boolean; handing it `true` trips a
        // g_value_get_int assertion once per icon.
        this.update_state([Gtk.AccessibleState.SELECTED],
            [selected ? Gtk.AccessibleTristate.TRUE : Gtk.AccessibleTristate.FALSE]);
    }

    /**
     * @param {Gdk.Texture} texture - a generated or cached thumbnail
     */
    setThumbnail(texture) {
        this._hasThumbnail = true;
        this._image.set_from_paintable(texture);
        this._image.add_css_class('has-thumbnail');
    }

    /**
     * @param {?Gio.Icon} icon - the default application's icon, or null for none
     */
    setApplicationIcon(icon) {
        this._applicationIcon = icon;

        // A thumbnail outranks both; do not paint over one.
        if (this._hasThumbnail)
            return;

        this._image.set_from_gicon(icon ?? this._item.icon);
    }

    _applyEmblems() {
        // Gio hands back the emblemed icon for symlinks only if asked for the
        // symbolic variant, so the marker is added here instead.
        if (this._item.isSymlink)
            this.add_css_class('is-symlink');
    }

    _accessibleName() {
        const {displayName, isDirectory, isSymlink} = this._item;
        const kind = isDirectory ? 'folder' : 'file';
        return isSymlink ? `${displayName}, link to a ${kind}` : `${displayName}, ${kind}`;
    }
});
