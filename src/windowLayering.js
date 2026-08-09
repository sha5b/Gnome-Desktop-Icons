// SPDX-License-Identifier: GPL-2.0-or-later
//
// Turns the helper's ordinary Wayland toplevels into desktop windows.
//
// Shell 49 added Meta.Window.set_type() and hide_from_window_list(), so this
// needs no XWayland trickery and no monkey-patching. Mutter itself then keeps a
// WindowType.DESKTOP window at the bottom of the stack and out of alt-tab.
//
// A Wayland client cannot position itself, so geometry is applied here with
// move_resize_frame(). The extension runs inside the compositor and may move a
// window that the client is not allowed to move.
//
// Windows are matched by pid *and* by title: the helper names each toplevel
// "desktop-icons-50:<monitor index>", which is how a Meta.Window is mapped back
// to the monitor it belongs to.

import Meta from 'gi://Meta';

import {debug} from './debug.js';
import * as Compat from './shellCompat.js';

const TITLE_PREFIX = 'desktop-icons-50:';

export class WindowLayering {
    constructor() {
        this._pid = 0;
        this._monitors = [];
        this._tracked = new Map(); // Meta.Window -> {handlerIds, index}
        this._disconnectCreated =
            Compat.connectWindowCreated((_display, window) => this._track(window));
    }

    /**
     * Adopt windows belonging to this process, now and in future.
     *
     * @param {number} pid - the helper's process id
     */
    watchPid(pid) {
        this._pid = pid;
        for (const window of Compat.listWindows())
            this._track(window);
    }

    /** Forget the current helper; its windows are gone or going. */
    unwatchPid() {
        this._pid = 0;
        for (const window of [...this._tracked.keys()])
            this._release(window);
    }

    /**
     * @param {object[]} monitors - snapshot from MonitorTracker
     */
    setMonitors(monitors) {
        this._monitors = monitors;
        for (const [window, entry] of this._tracked) {
            if (entry.index >= 0)
                this._applyGeometry(window, entry.index);
        }
    }

    destroy() {
        this._disconnectCreated();
        this._disconnectCreated = null;
        this.unwatchPid();
        this._monitors = [];
    }

    _track(window) {
        if (this._pid === 0 || this._tracked.has(window))
            return;
        if (window.get_pid() !== this._pid)
            return;

        const entry = {handlerIds: [], index: -1};
        entry.handlerIds.push(window.connect('unmanaged', () => this._release(window)));
        this._tracked.set(window, entry);

        // On Wayland the title usually arrives after the window is created.
        if (!this._adopt(window, entry))
            entry.handlerIds.push(window.connect('notify::title', () => this._adopt(window, entry)));
    }

    _adopt(window, entry) {
        if (entry.index >= 0)
            return true;

        const index = parseMonitorIndex(window.get_title());
        if (index < 0)
            return false;

        entry.index = index;
        window.set_type(Meta.WindowType.DESKTOP);
        window.hide_from_window_list();
        window.stick();
        this._applyGeometry(window, index);
        debug(`adopted the helper window for monitor ${index}`);
        return true;
    }

    _applyGeometry(window, index) {
        const monitor = this._monitors[index];
        if (!monitor) {
            // The monitor went away while the window was mapping; the helper
            // is about to destroy it.
            debug(`no geometry for monitor ${index}; leaving the window alone`);
            return;
        }

        window.move_resize_frame(false, monitor.x, monitor.y, monitor.width, monitor.height);
    }

    _release(window) {
        const entry = this._tracked.get(window);
        if (!entry)
            return;

        this._tracked.delete(window);
        for (const id of entry.handlerIds)
            window.disconnect(id);

        if (entry.index >= 0)
            debug(`released the helper window for monitor ${entry.index}`);

        // Reverse what _adopt() did, for the case where the window outlives us.
        if (entry.index >= 0) {
            window.show_in_window_list();
            window.set_type(Meta.WindowType.NORMAL);
        }
    }
}

/**
 * @param {?string} title - a Meta.Window title
 * @returns {number} the monitor index, or -1 if this is not a desktop window
 */
function parseMonitorIndex(title) {
    if (title === null || !title.startsWith(TITLE_PREFIX))
        return -1;

    const index = Number.parseInt(title.slice(TITLE_PREFIX.length), 10);
    return Number.isInteger(index) && index >= 0 ? index : -1;
}
