// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright 2026 Shahab Nedaei <ned.tabulov@gmail.com>
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
import Gtk from 'gi://Gtk?version=4.0';

import {IconView} from './iconView.js';
import {TITLE_PREFIX} from '../core/protocol.js';

export const DesktopWindow = GObject.registerClass(
class DesktopWindow extends Gtk.ApplicationWindow {
    _init(params) {
        const {monitorIndex, iconSize, iconSource, thumbnails, operations, onOpen,
            onSwitchWorkspace, ...windowParams} = params;

        super._init({
            title: `${TITLE_PREFIX}${monitorIndex}`,
            decorated: false,
            ...windowParams,
        });

        this.add_css_class('desktop-window');

        this._view = new IconView({iconSize, iconSource, thumbnails, operations,
            onOpen, onSwitchWorkspace});
        this.set_child(this._view);
    }

    /**
     * @param {object} monitor - one entry from the extension's monitor snapshot
     */
    setGeometry(monitor) {
        // Only a hint. The extension resizes the window server-side once it is
        // mapped, because a Wayland client cannot size itself to a monitor.
        this.set_default_size(monitor.width, monitor.height);
        this._view.setGeometry(monitor);
    }

    /**
     * @param {number} active - the workspace now showing
     * @param {number} count - how many workspaces exist
     */
    setWorkspaces(active, count) {
        this._view.setWorkspaces(active, count);
    }

    /**
     * @param {string} source - "type" or "application"
     */
    setIconSource(source) {
        this._view.setIconSource(source);
    }

    /**
     * @param {Gio.File} directory - the directory being shown
     * @param {object[]} items - items from the FileModel
     */
    setItems(directory, items) {
        this._view.setItems(directory, items);
    }

    destroy() {
        // The view owns things a destroyed widget does not release — a
        // GSettings listener, a pending timeout, parented popovers — so it is
        // torn down first, while its window still exists.
        this._view.destroy();
        super.destroy();
    }
});
