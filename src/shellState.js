// SPDX-License-Identifier: GPL-2.0-or-later
//
// Shell-wide state the helper needs but cannot observe for itself: it is an
// ordinary Wayland client and knows nothing about the overview.
//
// Only the overview is reported. Mutter still has a `showing-desktop-changed`
// signal, but there is no getter for the state and nothing in a stock GNOME 50
// session ever sets it — GNOME has had no "show desktop" mode since the
// classic-session days. If that changes, this is where it goes.

import * as Compat from './shellCompat.js';

export class ShellState {
    /**
     * @param {Function} onChanged - called when any reported state changes
     */
    constructor(onChanged) {
        this._onChanged = onChanged;
        this._overview = Compat.overviewVisible();

        // Take the value from the signal rather than re-reading the overview:
        // on `hiding` it still reports itself visible until the animation ends,
        // and the helper wants to start reacting at the beginning of it.
        this._disconnectOverview = Compat.connectOverview(
            () => this._setOverview(true),
            () => this._setOverview(false));
    }

    /** @returns {object} the current state, as sent over IPC */
    snapshot() {
        return {overview: this._overview};
    }

    destroy() {
        this._disconnectOverview();
        this._disconnectOverview = null;
        this._onChanged = null;
    }

    _setOverview(visible) {
        if (this._overview === visible)
            return;

        this._overview = visible;
        this._onChanged();
    }
}
