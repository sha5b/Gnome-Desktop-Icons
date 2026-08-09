// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright 2026 Shahab Nedaei <ned.tabulov@gmail.com>
//
// Spawns and supervises the GTK4 helper, and speaks line-delimited JSON to it
// over a private Unix socket.
//
// On spawning a subprocess: the review guidelines prefer D-Bus over spawning,
// but that rule is about shelling out to system commands and shipping binaries.
// This helper is our own unprivileged GJS script — which the guidelines
// explicitly endorse — and a separate process is the only way to use GTK, GTK
// menus and GTK drag-and-drop, none of which may be imported into the shell.
//
// Why a socket and not the child's stdout, which was the obvious first choice:
// the helper spawns grandchildren it does not control. Thumbnailers are
// external programs, and every application the user opens from the desktop is
// launched by the helper too. All of them inherit fd 1 and some of them print
// to it. One chatty thumbnailer is enough to inject garbage into the middle of
// the protocol. A socket is reachable only by a process that deliberately
// connects to it.
//
// The socket lives in XDG_RUNTIME_DIR, which is mode 0700, so no other user can
// reach it; the peer's pid is checked as well, so no other process of this user
// can drive the desktop either.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {debug} from './debug.js';

// GLib exposes no signal constants; 15 is SIGTERM on every platform GNOME runs
// on, and Gio.Subprocess.send_signal() takes the raw number.
const SIGTERM = 15;

const RESTART_DELAY_INITIAL_SECONDS = 1;
const RESTART_DELAY_MAX_SECONDS = 30;
// A helper that stayed up this long counts as healthy, so the backoff resets.
const HEALTHY_UPTIME_SECONDS = 30;

export class HelperProcess {
    /**
     * @param {object} params - configuration
     * @param {string[]} params.argv - command line to spawn, minus the socket
     * @param {Function} params.onMessage - called with each decoded message
     * @param {Function} params.onStarted - called with the new pid
     * @param {Function} params.onStopped - called after the child goes away
     */
    constructor({argv, onMessage, onStarted, onStopped}) {
        this._argv = argv;
        this._onMessage = onMessage;
        this._onStarted = onStarted;
        this._onStopped = onStopped;

        this._subprocess = null;
        this._connection = null;
        this._output = null;
        this._pending = [];
        this._cancellable = null;
        this._startedAt = 0;
        this._restartId = 0;
        this._restartDelay = RESTART_DELAY_INITIAL_SECONDS;
        this._stopping = false;

        this._socketPath = GLib.build_filenamev([
            GLib.get_user_runtime_dir(),
            `gnome-desktop-icons-${GLib.get_monotonic_time()}.sock`,
        ]);
        this._service = null;
    }

    start() {
        this._stopping = false;
        this._cancellable = new Gio.Cancellable();

        if (!this._listen())
            return;

        try {
            this._subprocess = Gio.Subprocess.new(
                [...this._argv, '--socket', this._socketPath],
                // Inherit stdio: the helper's diagnostics and anything its
                // children print land in the journal, where they belong, and
                // never in the protocol.
                Gio.SubprocessFlags.NONE);
        } catch (error) {
            console.error(`gnome-desktop-icons: cannot spawn helper: ${error.message}`);
            this._subprocess = null;
            this._scheduleRestart();
            return;
        }

        this._startedAt = GLib.get_monotonic_time();
        this._subprocess.wait_async(this._cancellable,
            (subprocess, result) => this._onExited(subprocess, result));

        const pid = Number.parseInt(this._subprocess.get_identifier(), 10);
        debug(`helper started, pid ${pid}`);
        this._onStarted(pid);
    }

    stop() {
        this._stopping = true;

        if (this._restartId) {
            GLib.Source.remove(this._restartId);
            this._restartId = 0;
        }

        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }

        this._dropConnection();
        this._pending = [];

        if (this._service) {
            this._service.stop();
            this._service.close();
            this._service = null;
        }
        GLib.unlink(this._socketPath);

        // Ask, do not shoot. Dropping the connection above already gives the
        // helper an EOF, which is its cue to quit; SIGTERM is the follow-up for
        // a helper that is wedged. force_exit() is SIGKILL, which would deny it
        // the chance to close its windows, and the guidelines are explicit that
        // spawned processes must exit cleanly. disable() does not wait for it:
        // the process is a child of the shell and cannot outlive the session.
        if (this._subprocess) {
            this._subprocess.send_signal(SIGTERM);
            this._subprocess = null;
        }
    }

    /**
     * @param {object} message - encoded as one JSON line
     */
    send(message) {
        const line = `${JSON.stringify(message)}\n`;

        // The helper takes a moment to connect. Hold everything sent before
        // then, or the first monitor layout is lost and the desktop stays blank.
        if (!this._output) {
            this._pending.push(line);
            return;
        }

        this._write(line);
    }

    _listen() {
        if (this._service)
            return true;

        // A stale file from a crashed session would make add_address fail.
        GLib.unlink(this._socketPath);

        this._service = new Gio.SocketService();
        this._service.connect('incoming', (_service, connection) => {
            this._onIncoming(connection);
            return true;
        });

        try {
            this._service.add_address(
                new Gio.UnixSocketAddress({path: this._socketPath}),
                Gio.SocketType.STREAM, Gio.SocketProtocol.DEFAULT, null);
        } catch (error) {
            console.error(`gnome-desktop-icons: cannot listen on ${this._socketPath}: ${error.message}`);
            this._service = null;
            return false;
        }

        this._service.start();
        return true;
    }

    _onIncoming(connection) {
        if (!this._isOurHelper(connection)) {
            console.warn('gnome-desktop-icons: refused a connection from another process');
            connection.close(null);
            return;
        }

        // A restarted helper connects again; the old connection is dead.
        this._dropConnection();

        this._connection = connection;
        this._output = new Gio.DataOutputStream({
            base_stream: connection.get_output_stream(),
        });
        this._input = new Gio.DataInputStream({
            base_stream: connection.get_input_stream(),
        });

        debug('helper connected');
        this._readLine();

        const pending = this._pending;
        this._pending = [];
        for (const line of pending)
            this._write(line);
    }

    _isOurHelper(connection) {
        if (!this._subprocess)
            return false;

        const credentials = connection.get_socket().get_credentials();
        return credentials.get_unix_pid() ===
            Number.parseInt(this._subprocess.get_identifier(), 10);
    }

    _dropConnection() {
        if (!this._connection)
            return;

        this._connection.close(null);
        this._connection = null;
        this._output = null;
        this._input = null;
    }

    _write(line) {
        try {
            this._output.put_string(line, null);
        } catch (error) {
            // The child died between the last read and this write.
            console.warn(`gnome-desktop-icons: cannot write to helper: ${error.message}`);
        }
    }

    _readLine() {
        this._input.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable,
            (stream, result) => {
                let line;
                try {
                    [line] = stream.read_line_finish_utf8(result);
                } catch (error) {
                    if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.warn(`gnome-desktop-icons: helper read failed: ${error.message}`);
                    return;
                }

                if (line === null)
                    return; // EOF; wait_async reports the exit.

                this._dispatch(line);
                this._readLine();
            });
    }

    _dispatch(line) {
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            console.warn(`gnome-desktop-icons: helper sent invalid JSON: ${line}`);
            return;
        }

        this._onMessage(message);
    }

    _onExited(subprocess, result) {
        try {
            subprocess.wait_finish(result);
        } catch {
            return; // Cancelled by stop().
        }

        if (this._stopping)
            return;

        const uptime = (GLib.get_monotonic_time() - this._startedAt) / GLib.USEC_PER_SEC;
        if (uptime >= HEALTHY_UPTIME_SECONDS)
            this._restartDelay = RESTART_DELAY_INITIAL_SECONDS;

        // Warning, not error: the helper going away is survivable and the
        // restart below fixes it. console.error() surfaces as CRITICAL in the
        // journal and reads like the extension itself is broken.
        console.warn(`gnome-desktop-icons: helper exited after ${Math.round(uptime)}s`);

        this._dropConnection();
        this._subprocess = null;
        this._onStopped();
        this._scheduleRestart();
    }

    _scheduleRestart() {
        if (this._stopping || this._restartId)
            return;

        const delay = this._restartDelay;
        this._restartDelay = Math.min(delay * 2, RESTART_DELAY_MAX_SECONDS);

        debug(`restarting the helper in ${delay}s`);
        this._restartId = GLib.timeout_add_seconds_once(GLib.PRIORITY_DEFAULT, delay, () => {
            this._restartId = 0;
            this.start();
        });
    }
}
