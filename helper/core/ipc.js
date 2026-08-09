// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright 2026 Shahab Nedaei <ned.tabulov@gmail.com>
//
// Helper side of the line-delimited JSON link, over the private Unix socket the
// extension is listening on. See src/helperProcess.js for why this is not the
// process's stdout: thumbnailers and launched applications inherit fd 1 and
// print to it, which would corrupt the protocol.
//
// Diagnostics go to stderr, which the extension lets through to the journal.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export class Ipc {
    /**
     * @param {object} params - configuration
     * @param {string} params.socketPath - the extension's listening socket
     * @param {Function} params.onMessage - called with each decoded message
     * @param {Function} params.onClosed - called when the extension goes away
     */
    constructor({socketPath, onMessage, onClosed}) {
        this._onMessage = onMessage;
        this._onClosed = onClosed;
        this._cancellable = new Gio.Cancellable();

        // Connecting synchronously keeps startup simple: there is nothing
        // useful to do until the extension has told us the monitor layout.
        this._connection = new Gio.SocketClient().connect(
            new Gio.UnixSocketAddress({path: socketPath}), this._cancellable);

        this._input = new Gio.DataInputStream({
            base_stream: this._connection.get_input_stream(),
        });
        this._output = new Gio.DataOutputStream({
            base_stream: this._connection.get_output_stream(),
        });

        this._readLine();
    }

    /**
     * @param {object} message - encoded as one JSON line
     */
    send(message) {
        if (!this._output)
            return;

        try {
            this._output.put_string(`${JSON.stringify(message)}\n`, null);
        } catch (error) {
            printerr(`ipc: cannot write: ${error.message}`);
        }
    }

    destroy() {
        this._cancellable.cancel();
        this._input = null;
        this._output = null;

        if (this._connection) {
            this._connection.close(null);
            this._connection = null;
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
                        printerr(`ipc: read failed: ${error.message}`);
                    return;
                }

                if (line === null) {
                    this._onClosed();
                    return;
                }

                this._dispatch(line);
                this._readLine();
            });
    }

    _dispatch(line) {
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            printerr(`ipc: invalid JSON: ${line}`);
            return;
        }

        this._onMessage(message);
    }
}
