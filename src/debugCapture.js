// SPDX-License-Identifier: GPL-2.0-or-later
//
// Screenshots a nested shell from the inside.
//
// The desktop only exists inside a throwaway `gnome-shell --devkit` session, and
// org.gnome.Shell.Screenshot on the bus refuses every caller but the shell's own
// UI, so there is no way to look at the result from outside. This writes the
// stage to a file instead. Constructed only when the environment asks for it:
//
//   DESKTOP_ICONS_50_DEBUG_SHOT=/tmp/desktop.png gnome-shell --devkit --wayland
//
// Never active in an installed extension.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

import * as Compat from './shellCompat.js';
import {debug} from './debug.js';

// Long enough for the helper to spawn, map its windows and settle.
const OPEN_DELAY_SECONDS = 10;
// Time for an animation — the overview closing, a menu opening — to finish.
const SETTLE_SECONDS = 2;

/**
 * An optional click to perform before the shutter, as "x,y" or "x,y,button".
 * There is no other way to reach a nested shell: it has no session bus a test
 * script can drive, and the pointer belongs to the outer compositor.
 *
 *   DESKTOP_ICONS_50_DEBUG_CLICK=72,216,3   right-click that spot, then shoot
 *
 * @returns {?object} the parsed click, or null if none was asked for
 */
function clickSpec() {
    const raw = GLib.getenv('DESKTOP_ICONS_50_DEBUG_CLICK');
    if (!raw)
        return null;

    const [x, y, button] = raw.split(',').map(part => Number.parseInt(part, 10));
    if (!Number.isInteger(x) || !Number.isInteger(y))
        return null;

    return {x, y, button: Number.isInteger(button) ? button : Clutter.BUTTON_PRIMARY};
}

/** @returns {?string} the file to write to, if capture was asked for */
export function capturePath() {
    return GLib.getenv('DESKTOP_ICONS_50_DEBUG_SHOT');
}

export class DebugCapture {
    /**
     * @param {string} path - file to write the PNG to
     */
    constructor(path) {
        this._path = path;
        this._timeoutIds = [];
        this._pointer = null;

        // A shell with no windows sits in the overview, where the desktop is
        // behind the workspace previews and invisible. Close it first, or every
        // screenshot is a picture of the overview.
        this._defer(OPEN_DELAY_SECONDS, () => Compat.hideOverview());

        const click = clickSpec();
        let shutter = OPEN_DELAY_SECONDS + SETTLE_SECONDS;
        if (click) {
            this._defer(shutter, () => this._click(click));
            shutter += SETTLE_SECONDS;
        }

        this._defer(shutter, () => this._capture());
    }

    destroy() {
        for (const id of this._timeoutIds)
            GLib.Source.remove(id);
        this._timeoutIds = [];
    }

    _defer(seconds, callback) {
        const id = GLib.timeout_add_seconds_once(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._timeoutIds = this._timeoutIds.filter(other => other !== id);
            callback();
        });
        this._timeoutIds.push(id);
    }

    _click({x, y, button}) {
        const seat = Clutter.get_default_backend().get_default_seat();
        this._pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);

        // warp_pointer places the cursor; the virtual device presses it. The
        // press has to be a separate main-loop turn from the motion, or it is
        // delivered before the new pointer focus is established.
        seat.warp_pointer(x, y);
        GLib.idle_add_once(GLib.PRIORITY_DEFAULT, () => {
            this._pointer.notify_button(GLib.get_monotonic_time(),
                button, Clutter.ButtonState.PRESSED);
            this._pointer.notify_button(GLib.get_monotonic_time(),
                button, Clutter.ButtonState.RELEASED);
            debug(`clicked button ${button} at ${x},${y}`);
        });
    }

    _capture() {
        const stream = Gio.File.new_for_path(this._path)
            .replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);

        new Shell.Screenshot().screenshot(false, stream, (shooter, result) => {
            try {
                shooter.screenshot_finish(result);
                debug(`wrote a screenshot to ${this._path}`);
            } catch (error) {
                debug(`screenshot failed: ${error.message}`);
            }
        });
    }
}
