// SPDX-License-Identifier: GPL-2.0-or-later
//
// Opt-in tracing for the shell-process code. Silent unless
// DESKTOP_ICONS_50_DEBUG=1 is in the shell's environment, so an installed
// extension never adds noise to the journal.
//
// The shell cannot be restarted on Wayland, which makes a printf trail the
// main debugging tool; a nested shell is started with the variable set:
//
//   DESKTOP_ICONS_50_DEBUG=1 gnome-shell --devkit --wayland

import GLib from 'gi://GLib';

const ENABLED = GLib.getenv('DESKTOP_ICONS_50_DEBUG') === '1';

/**
 * @param {string} message - what happened, in the present tense
 */
export function debug(message) {
    if (ENABLED)
        console.log(`desktop-icons-50: ${message}`);
}

/** @returns {boolean} whether tracing is on */
export function debugEnabled() {
    return ENABLED;
}
