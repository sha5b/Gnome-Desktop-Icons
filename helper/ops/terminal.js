// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright 2026 Shahab Nedaei <ned.tabulov@gmail.com>
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

import {_, format} from '../core/gettext.js';

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

// How each terminal is told "and then run this". There is no standard for it;
// `--` is the modern spelling and `-e` the old one, and they are not
// interchangeable — konsole and xterm only understand `-e`.
const EXEC_FLAGS = {
    'ptyxis': ['--'],
    'kgx': ['--'],
    'gnome-terminal': ['--'],
    'xfce4-terminal': ['-x'],
    'konsole': ['-e'],
    'alacritty': ['-e'],
    'xterm': ['-e'],
    'foot': [],
};

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

/**
 * Run a script in a terminal window, as the user.
 *
 * The terminal is kept open after the script finishes. A script that fails in
 * a window that vanishes with it is a script that cannot be debugged, and the
 * whole point of running it in a terminal rather than silently is to watch what
 * it does.
 *
 * There is deliberately no "as root" variant. The review guidelines require a
 * privileged subprocess to run under pkexec *and* not to be a script a user
 * process can modify; a file on the user's own desktop fails the second
 * condition no matter how it is launched. The terminal is right there, and
 * typing `sudo` in it is the user's call, not ours.
 *
 * @param {Gio.File} script - the file to run
 * @returns {boolean} whether a terminal was launched
 */
export function runInTerminal(script) {
    const path = script.get_path();
    if (!path) {
        printerr('terminal: refusing to run a script from a non-local location');
        return false;
    }

    const directory = script.get_parent()?.get_path() ?? GLib.get_home_dir();
    // Keep the window open on exit, and say why it closed. The message is
    // translated here, so the placeholder is a %s that bash's $status fills;
    // the translated text is escaped for the double quotes around it before
    // the placeholder goes in.
    const message = format(
        _('[exited with %s — press Enter to close]').replace(/["$`\\]/g, '\\$&'),
        '$status');
    const shellScript = `${GLib.shell_quote(path)}; status=$?; echo; ` +
        `echo "${message}"; read _`;

    for (const terminal of candidates()) {
        if (!GLib.find_program_in_path(terminal))
            continue;

        const flags = EXEC_FLAGS[terminal] ?? ['--'];
        const argv = [terminal, ...flags, 'bash', '-c', shellScript];

        try {
            GLib.spawn_async(directory, argv, null, GLib.SpawnFlags.SEARCH_PATH, null);
            return true;
        } catch (error) {
            printerr(`terminal: ${terminal} could not run the script: ${error.message}`);
        }
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
