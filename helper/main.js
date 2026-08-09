#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright 2026 Shahab Nedaei <ned.tabulov@gmail.com>
//
// The GTK4 helper. Runs as an ordinary Wayland client, spawned and supervised
// by the extension, which passes `--socket <path>` for the IPC link.
//
// Run without --socket it opens one ordinary window covering the default
// monitor, which is how the grid, the menus and the file operations are
// debugged without a shell in the way.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import System from 'system';

import {DesktopWindow} from './desktopWindow.js';
import {FileModel} from './fileModel.js';
import {Ipc} from './ipc.js';
import {NautilusOps} from './nautilusOps.js';
import {ThumbnailLoader} from './thumbnails.js';
import {isTrustedLauncher} from './iconView.js';

const APPLICATION_ID = 'io.github.sha5b.GnomeDesktopIcons';
const HELPER_DIR = Gio.File.new_for_uri(import.meta.url).get_parent();

// Logical pixels. GTK multiplies these by the monitor's scale factor itself, so
// one set of numbers is right on every display.
const ICON_SIZES = {small: 48, standard: 64, large: 96};
const DEFAULT_ICON_SIZE = ICON_SIZES.standard;

class DesktopHelper {
    /**
     * @param {?string} socketPath - the extension's IPC socket, if spawned by it
     */
    constructor(socketPath) {
        this._socketPath = socketPath;
        this._windows = new Map(); // monitor index -> DesktopWindow
        this._ipc = null;
        this._shellState = {overview: false};
        this._iconSize = DEFAULT_ICON_SIZE;

        this._directory = Gio.File.new_for_path(
            GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DESKTOP) ??
            GLib.build_filenamev([GLib.get_home_dir(), 'Desktop']));

        this._thumbnails = new ThumbnailLoader();
        this._operations = new NautilusOps();
        this._model = new FileModel({
            directory: this._directory,
            onChanged: items => this._setItems(items),
        });

        this._application = new Adw.Application({
            application_id: APPLICATION_ID,
            // The extension may restart us while an old instance is still
            // shutting down; a unique-name handshake would turn that into a
            // silent no-op.
            flags: Gio.ApplicationFlags.NON_UNIQUE,
        });
        this._application.connect('startup', () => this._startup());
        this._application.connect('activate', () => this._activate());
        this._application.connect('shutdown', () => this._shutdown());
    }

    /**
     * @param {string[]} argv - process arguments
     * @returns {number} exit status
     */
    run(argv) {
        return this._application.run(argv);
    }

    _startup() {
        // Nothing but desktop windows: keep running with no window presented.
        this._application.hold();
        this._loadStyles();
        this._model.start();

        if (!this._socketPath) {
            this._runStandalone();
            return;
        }

        this._ipc = new Ipc({
            socketPath: this._socketPath,
            onMessage: message => this._onMessage(message),
            onClosed: () => this._application.quit(),
        });
        this._ipc.send({type: 'ready'});
    }

    /** No extension: invent a monitor from GDK so there is something to look at. */
    _runStandalone() {
        const display = Gdk.Display.get_default();
        const gdkMonitor = display.get_monitors().get_item(0);
        const {width, height} = gdkMonitor.get_geometry();

        printerr('helper: no --socket; running standalone in one window');
        this._setMonitors([{
            index: 0,
            x: 0,
            y: 0,
            width,
            height,
            scale: gdkMonitor.get_scale_factor(),
            primary: true,
            workArea: {x: 0, y: 0, width, height},
        }]);
    }

    _activate() {
        // GApplication requires the handler; the shell drives us over IPC.
    }

    _shutdown() {
        this._model.stop();
        this._thumbnails.destroy();
        this._operations.destroy();

        for (const window of this._windows.values())
            window.destroy();
        this._windows.clear();

        if (this._ipc) {
            this._ipc.close();
            this._ipc = null;
        }
    }

    _loadStyles() {
        const provider = new Gtk.CssProvider();
        provider.load_from_path(
            HELPER_DIR.get_parent().get_child('data').get_child('helper.css').get_path());
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    }

    _onMessage(message) {
        switch (message.type) {
        case 'monitors':
            this._setMonitors(message.monitors);
            break;
        case 'state':
            this._setShellState({overview: message.overview});
            break;
        case 'settings':
            this._setSettings(message);
            break;
        default:
            printerr(`helper: unknown message "${message.type}"`);
            break;
        }
    }

    _setMonitors(monitors) {
        this._monitors = monitors;
        const live = new Set();

        for (const monitor of monitors) {
            live.add(monitor.index);

            let window = this._windows.get(monitor.index);
            if (!window) {
                window = new DesktopWindow({
                    application: this._application,
                    monitorIndex: monitor.index,
                    iconSize: this._iconSize,
                    thumbnails: this._thumbnails,
                    operations: this._operations,
                    onOpen: items => this._open(items),
                });
                window.setShellState(this._shellState);
                this._windows.set(monitor.index, window);
            }

            window.setGeometry(monitor);
            window.setItems(this._directory, this._model.items);
            window.present();
        }

        for (const [index, window] of [...this._windows]) {
            if (!live.has(index)) {
                window.destroy();
                this._windows.delete(index);
            }
        }
    }

    _setItems(items) {
        for (const window of this._windows.values())
            window.setItems(this._directory, items);
    }

    _setSettings({iconSize, showHidden}) {
        this._model.setShowHidden(showHidden);

        const size = ICON_SIZES[iconSize] ?? DEFAULT_ICON_SIZE;
        if (size === this._iconSize)
            return;

        // Cell size is derived from the icon size, so the whole grid has to be
        // rebuilt rather than just re-scaled.
        this._iconSize = size;
        for (const window of this._windows.values())
            window.destroy();
        this._windows.clear();

        if (this._monitors)
            this._setMonitors(this._monitors);
    }

    _setShellState(state) {
        this._shellState = state;
        for (const window of this._windows.values())
            window.setShellState(state);
    }

    _open(items) {
        // Launch through the display's context, not with a null one. It carries
        // the startup-notification id and the display environment, which is what
        // tells the new process which monitor and which scale factor it is
        // starting on; without it some applications come up at the wrong size.
        const context = Gdk.Display.get_default().get_app_launch_context();
        context.set_timestamp(Gdk.CURRENT_TIME);

        for (const item of items) {
            if (isTrustedLauncher(item)) {
                launchDesktopEntry(item, context);
                continue;
            }

            Gio.AppInfo.launch_default_for_uri_async(item.uri, context, null,
                (_source, result) => {
                    try {
                        Gio.AppInfo.launch_default_for_uri_finish(result);
                    } catch (error) {
                        printerr(`helper: cannot open ${item.uri}: ${error.message}`);
                    }
                });
        }
    }
}

/**
 * @param {object} item - a .desktop file the user has marked executable
 * @param {Gdk.AppLaunchContext} context - the display's launch context
 */
function launchDesktopEntry(item, context) {
    const appInfo = Gio.DesktopAppInfo.new_from_filename(item.file.get_path());
    if (!appInfo) {
        printerr(`helper: ${item.name} is not a valid desktop entry`);
        return;
    }

    try {
        appInfo.launch([], context);
    } catch (error) {
        printerr(`helper: cannot launch ${item.name}: ${error.message}`);
    }
}

/**
 * @param {string[]} argv - process arguments
 * @returns {?string} the value of --socket, if given
 */
function socketPathFrom(argv) {
    const index = argv.indexOf('--socket');
    return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
}

const args = System.programArgs;
const helper = new DesktopHelper(socketPathFrom(args));
// GApplication would choke on --socket; it never needs our arguments.
System.exit(helper.run([System.programInvocationName]));
