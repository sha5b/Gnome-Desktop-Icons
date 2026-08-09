// SPDX-License-Identifier: GPL-2.0-or-later
//
// Watches monitor layout, work areas and scale, and reports a plain-object
// snapshot the helper process can consume over IPC.

import GLib from 'gi://GLib';

import {debug} from './debug.js';
import * as Compat from './shellCompat.js';

export class MonitorTracker {
    /**
     * @param {Function} onChanged - called when the layout actually differs
     */
    constructor(onChanged) {
        this._onChanged = onChanged;
        this._idleId = 0;
        this._serialized = null;
        this._disconnects = [
            Compat.connectMonitorsChanged(() => this._queueNotify()),
            Compat.connectWorkareasChanged(() => this._queueNotify()),
            Compat.connectScaleChanged(() => this._queueNotify()),
        ];
    }

    /**
     * @returns {object[]} one entry per monitor, all values in logical pixels
     */
    snapshot() {
        const snapshot = this._build();
        this._serialized = JSON.stringify(snapshot);
        return snapshot;
    }

    destroy() {
        if (this._idleId) {
            GLib.Source.remove(this._idleId);
            this._idleId = 0;
        }
        for (const disconnect of this._disconnects)
            disconnect();
        this._disconnects = [];
        this._onChanged = null;
    }

    _build() {
        const primary = Compat.primaryIndex();
        const globalScale = Compat.scaleFactor();

        return Compat.monitors().map((monitor, index) => {
            const workArea = Compat.workArea(index);
            return {
                index,
                x: monitor.x,
                y: monitor.y,
                width: monitor.width,
                height: monitor.height,
                scale: monitor.geometry_scale,
                globalScale,
                primary: index === primary,
                workArea: {
                    x: workArea.x,
                    y: workArea.y,
                    width: workArea.width,
                    height: workArea.height,
                },
            };
        });
    }

    // A hotplug fires monitors-changed and workareas-changed back to back, so
    // the notification is coalesced to one idle. workareas-changed also fires
    // every time a window maximises, which does not move a monitor — compare
    // the result and stay quiet when nothing the helper cares about moved,
    // rather than resizing every desktop window for no reason.
    _queueNotify() {
        if (this._idleId)
            return;

        this._idleId = GLib.idle_add_once(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idleId = 0;

            const serialized = JSON.stringify(this._build());
            if (serialized === this._serialized) {
                debug('monitor layout unchanged; not republishing');
                return;
            }

            this._serialized = serialized;
            this._onChanged();
        });
    }
}
