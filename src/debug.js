// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright 2026 Shahab Nedaei <ned.tabulov@gmail.com>
//
// Opt-in tracing for the shell-process code. Silent unless
// GNOME_DESKTOP_ICONS_DEBUG=1 is in the shell's environment, so an installed
// extension never adds noise to the journal.
//
// The shell cannot be restarted on Wayland, which makes a printf trail the
// main debugging tool; a nested shell is started with the variable set:
//
//   GNOME_DESKTOP_ICONS_DEBUG=1 gnome-shell --devkit --wayland

import GLib from 'gi://GLib';

const ENABLED = GLib.getenv('GNOME_DESKTOP_ICONS_DEBUG') === '1';

/**
 * @param {string} message - what happened, in the present tense
 */
export function debug(message) {
    if (ENABLED)
        console.log(`gnome-desktop-icons: ${message}`);
}

/** @returns {boolean} whether tracing is on */
export function debugEnabled() {
    return ENABLED;
}
