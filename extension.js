// SPDX-License-Identifier: GPL-2.0-or-later
//
// Entry point. Everything here is lifecycle: build four objects in enable(),
// tear the same four down in disable(). All real work happens in src/ and in
// the helper process.

import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {debug} from './src/debug.js';
import {DebugCapture, capturePath} from './src/debugCapture.js';
import {HelperProcess} from './src/helperProcess.js';
import {MonitorTracker} from './src/monitorTracker.js';
import {ShellState} from './src/shellState.js';
import {WindowLayering} from './src/windowLayering.js';

export default class DesktopIconsExtension extends Extension {
    enable() {
        this._layering = new WindowLayering();
        this._monitors = new MonitorTracker(() => this._publishMonitors());
        this._state = new ShellState(() => this._publishState());
        this._helper = new HelperProcess({
            argv: ['gjs', '-m', GLib.build_filenamev([this.path, 'helper', 'main.js'])],
            onMessage: message => this._onHelperMessage(message),
            onStarted: pid => this._layering.watchPid(pid),
            onStopped: () => this._layering.unwatchPid(),
        });
        this._helper.start();

        const shotPath = capturePath();
        this._capture = shotPath ? new DebugCapture(shotPath) : null;

        debug('enabled');
    }

    disable() {
        this._capture?.destroy();
        this._capture = null;

        this._helper.stop();
        this._helper = null;

        this._state.destroy();
        this._state = null;

        this._monitors.destroy();
        this._monitors = null;

        this._layering.destroy();
        this._layering = null;
        debug('disabled');
    }

    _publishMonitors() {
        const monitors = this._monitors.snapshot();
        // Layering first: the helper may map a window as soon as it reads this,
        // and the geometry has to be waiting for it when it does.
        this._layering.setMonitors(monitors);
        this._helper.send({type: 'monitors', monitors});
        debug(`published ${monitors.length} monitor(s): ${monitors.map(describeMonitor).join(', ')}`);
    }

    _publishState() {
        this._helper.send({type: 'state', ...this._state.snapshot()});
    }

    _onHelperMessage(message) {
        switch (message.type) {
        case 'ready':
            // The helper has just started, or just restarted after a crash, and
            // knows nothing yet. Send it everything.
            this._publishMonitors();
            this._publishState();
            break;
        case 'log':
            console.log(`desktop-icons-50 helper: ${message.text}`);
            break;
        default:
            console.warn(`desktop-icons-50: unknown message "${message.type}"`);
            break;
        }
    }
}

/**
 * @param {object} monitor - one entry from the monitor snapshot
 * @returns {string} a compact description for the debug trace
 */
function describeMonitor(monitor) {
    const {x, y, width, height, scale, workArea} = monitor;
    return `${width}x${height}+${x}+${y} @${scale}x ` +
        `work ${workArea.width}x${workArea.height}+${workArea.x}+${workArea.y}`;
}
