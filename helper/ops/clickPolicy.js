// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright 2026 Shahab Nedaei <ned.tabulov@gmail.com>
//
// Single click or double click to open, taken from Files.
//
// This is not our preference to invent. A user who has set Files to open on a
// single click expects the desktop to behave the same way, and the desktop is
// the one place where disagreeing is most jarring — the two surfaces sit side
// by side. So the setting is read from Nautilus itself and followed live.
//
// Nautilus may not be installed, in which case the schema is missing and we
// fall back to double click, the GNOME default.

import Gio from 'gi://Gio';

const NAUTILUS_SCHEMA = 'org.gnome.nautilus.preferences';

export class ClickPolicy {
    /**
     * @param {Function} onChanged - called when the policy changes
     */
    constructor(onChanged) {
        this._onChanged = onChanged;
        this._settings = null;
        this._changedId = 0;
        this._singleClick = false;

        const source = Gio.SettingsSchemaSource.get_default();
        if (!source?.lookup(NAUTILUS_SCHEMA, true))
            return;

        this._settings = new Gio.Settings({schema_id: NAUTILUS_SCHEMA});
        this._changedId = this._settings.connect('changed::click-policy',
            () => this._reload());
        this._reload();
    }

    /** @returns {boolean} whether one click should open an item */
    get singleClick() {
        return this._singleClick;
    }

    destroy() {
        if (this._settings) {
            this._settings.disconnect(this._changedId);
            this._settings = null;
        }
        this._onChanged = null;
    }

    _reload() {
        // An older Nautilus can ship the schema without the key; fall back to
        // double click, the GNOME default, exactly as a missing schema does.
        const singleClick = this._settings.settings_schema.has_key('click-policy') &&
            this._settings.get_string('click-policy') === 'single';
        if (singleClick === this._singleClick)
            return;

        this._singleClick = singleClick;
        this._onChanged();
    }
}
