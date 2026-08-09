// SPDX-License-Identifier: GPL-2.0-or-later
//
// One transparent toplevel per monitor, holding that monitor's icon grid.
//
// The window cannot place itself: it is an ordinary Wayland client. The title
// carries the monitor index so the extension can find it and apply geometry
// with move_resize_frame(); see src/windowLayering.js.
//
// M0.5 established that this works: Mutter puts the window at the bottom of the
// stack on every workspace, keeps it out of alt-tab, gives it the whole monitor
// rather than the work area, and still delivers pointer and keyboard events.

import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {IconView} from './iconView.js';

const TITLE_PREFIX = 'desktop-icons-50:';

export const DesktopWindow = GObject.registerClass(
class DesktopWindow extends Gtk.ApplicationWindow {
    _init(params) {
        const {monitorIndex, iconSize, thumbnails, operations, onOpen, ...windowParams} = params;

        super._init({
            title: `${TITLE_PREFIX}${monitorIndex}`,
            decorated: false,
            ...windowParams,
        });

        this._monitorIndex = monitorIndex;
        this._monitor = null;
        this.add_css_class('desktop-window');

        this._view = new IconView({iconSize, thumbnails, operations, onOpen});
        this.set_child(this._view);
    }

    /** @returns {number} the monitor this window belongs to */
    get monitorIndex() {
        return this._monitorIndex;
    }

    /**
     * @param {object} monitor - one entry from the extension's monitor snapshot
     */
    setGeometry(monitor) {
        this._monitor = monitor;
        // Only a hint. The extension resizes the window server-side once it is
        // mapped, because a Wayland client cannot size itself to a monitor.
        this.set_default_size(monitor.width, monitor.height);
        this._view.setGeometry(monitor);
    }

    /**
     * @param {Gio.File} directory - the directory being shown
     * @param {object[]} items - items from the FileModel
     */
    setItems(directory, items) {
        this._view.setItems(directory, items);
    }

    /**
     * @param {object} state - shell state from the extension
     * @param {boolean} state.overview - whether the overview is open
     */
    setShellState(state) {
        // Nothing to do yet. The desktop is behind the overview rather than
        // hidden by it, and Mutter keeps it out of the window previews.
        this._overview = state.overview;
    }
});
