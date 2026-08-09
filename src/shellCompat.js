// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright 2026 Shahab Nedaei <ned.tabulov@gmail.com>
//
// Every use of a GNOME Shell *internal* API lives in this file. Mutter, GLib,
// Gio and GObject are stable platform libraries and may be used anywhere else
// in the shell-process code; `Main`, `St` and `global` may not. When a future
// Shell release moves something, this is the only file to repair.
//
// Each connect* function returns a disconnect thunk, so callers never have to
// remember which object a handler id belongs to.

import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/** @returns {object[]} the shell's monitor list, in logical pixels */
export function monitors() {
    return Main.layoutManager.monitors;
}

/** @returns {number} index into monitors() of the primary monitor */
export function primaryIndex() {
    return Main.layoutManager.primaryIndex;
}

/**
 * @param {number} index - monitor index
 * @returns {Mtk.Rectangle} the monitor's work area, in logical pixels
 */
export function workArea(index) {
    return Main.layoutManager.getWorkAreaForMonitor(index);
}

/** @returns {number} the global integer scale factor */
export function scaleFactor() {
    return St.ThemeContext.get_for_stage(global.stage).scale_factor;
}

/** @returns {Meta.Window[]} every currently managed window */
export function listWindows() {
    return global.get_window_actors().map(actor => actor.meta_window);
}

/** Close the overview. Only the debug capture needs this. */
export function hideOverview() {
    Main.overview.hide();
}

/**
 * @param {Function} callback - called when monitors are added or removed
 * @returns {Function} disconnect thunk
 */
export function connectMonitorsChanged(callback) {
    const id = Main.layoutManager.connect('monitors-changed', callback);
    return () => Main.layoutManager.disconnect(id);
}

/**
 * @param {Function} callback - called when any monitor's work area changes
 * @returns {Function} disconnect thunk
 */
export function connectWorkareasChanged(callback) {
    const id = global.display.connect('workareas-changed', callback);
    return () => global.display.disconnect(id);
}

/**
 * @param {Function} callback - called when the global scale factor changes
 * @returns {Function} disconnect thunk
 */
export function connectScaleChanged(callback) {
    const context = St.ThemeContext.get_for_stage(global.stage);
    const id = context.connect('notify::scale-factor', callback);
    return () => context.disconnect(id);
}

/**
 * @param {Function} callback - called as (display, window) for each new window
 * @returns {Function} disconnect thunk
 */
export function connectWindowCreated(callback) {
    const id = global.display.connect('window-created', callback);
    return () => global.display.disconnect(id);
}
