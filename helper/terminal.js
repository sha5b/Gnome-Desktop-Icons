// SPDX-License-Identifier: GPL-2.0-or-later
//
// "Open in Terminal", the way Files does it.
//
// There is no portable D-Bus interface for "give me a shell here", so the
// terminal is found by asking, in order: the GSettings key desktops have used
// for years, the freedesktop `xdg-terminal-exec` helper that is meant to
// replace it, and finally the terminals that actually ship on GNOME systems.
//
// The directory is passed as the child's working directory rather than as a
// command-line flag. Every terminal honours that; the flag for it is spelled
// differently by each one.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const FALLBACK_TERMINALS = [
    'ptyxis',           // Fedora's default since 41
    'kgx',              // GNOME Console
    'gnome-terminal',
    'konsole',
    'xfce4-terminal',
    'alacritty',
    'foot',
    'xterm',
];

const TERMINAL_SCHEMA = 'org.gnome.desktop.default-applications.terminal';

/**
 * @param {Gio.File} directory - where the shell should start
 * @returns {boolean} whether a terminal was launched
 */
export function openTerminal(directory) {
    const path = directory.get_path();
    if (!path) {
        printerr('terminal: refusing to open a shell in a non-local location');
        return false;
    }

    for (const command of candidates()) {
        if (spawn(command, path))
            return true;
    }

    printerr('terminal: no terminal emulator found');
    return false;
}

/** @returns {string[]} terminal commands to try, best first */
function candidates() {
    const commands = [];

    const configured = configuredTerminal();
    if (configured)
        commands.push(configured);

    commands.push('xdg-terminal-exec');
    commands.push(...FALLBACK_TERMINALS);

    return commands.filter((command, index) => commands.indexOf(command) === index);
}

/** @returns {?string} the terminal named in GSettings, if the schema exists */
function configuredTerminal() {
    const source = Gio.SettingsSchemaSource.get_default();
    if (!source?.lookup(TERMINAL_SCHEMA, true))
        return null;

    const exec = new Gio.Settings({schema_id: TERMINAL_SCHEMA}).get_string('exec');
    return exec === '' ? null : exec;
}

/**
 * @param {string} command - a terminal binary
 * @param {string} workingDirectory - where to start it
 * @returns {boolean} whether it started
 */
function spawn(command, workingDirectory) {
    if (!GLib.find_program_in_path(command))
        return false;

    try {
        GLib.spawn_async(workingDirectory, [command], null,
            GLib.SpawnFlags.SEARCH_PATH, null);
        return true;
    } catch (error) {
        printerr(`terminal: ${command} failed to start: ${error.message}`);
        return false;
    }
}
