// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright 2026 Shahab Nedaei <ned.tabulov@gmail.com>
//
// Where each icon sits, remembered on the file itself.
//
// The position is stored in the file's `metadata::gnome-desktop-icons-position`
// attribute as "ws,x,y" — the workspace the icon belongs to, then its spot in
// global logical pixels. GIO keeps these in its own metadata store, not in the
// file, so nothing is written to the user's documents.
//
// The workspace is what makes one desktop per workspace possible: an icon is
// only drawn where it belongs, and dragging it across a screen edge moves that
// membership. Coordinates are global logical pixels: the monitor's origin plus
// the offset within it. That single number pair says both where an icon is and
// which monitor it is on, and it degrades well — a position belonging to a
// monitor that is no longer attached simply fails the bounds test and the icon
// falls back to automatic placement.
//
// Positions saved before workspaces existed, by this extension or by the
// Nautilus desktop, live in `metadata::nautilus-icon-position` as "x,y". They
// are read as belonging to workspace 0 — a migration path, not a rewrite: the
// old attribute is never written again, and the next drag stores the position
// under the new name.

import Gio from 'gi://Gio';

import {POSITION_ATTRIBUTE} from '../core/protocol.js';

const LEGACY_ATTRIBUTE = 'metadata::nautilus-icon-position';

/**
 * @param {Gio.FileInfo} info - an entry, queried with metadata::*
 * @returns {?object} the saved {ws, x, y}, or null if the icon has never been moved
 */
export function readPosition(info) {
    const raw = info.get_attribute_string(POSITION_ATTRIBUTE);
    if (raw) {
        const [ws, x, y] = raw.split(',').map(part => Number.parseInt(part, 10));
        if (Number.isInteger(ws) && Number.isInteger(x) && Number.isInteger(y))
            return {ws, x, y};
    }

    const legacy = info.get_attribute_string(LEGACY_ATTRIBUTE);
    if (!legacy)
        return null;

    const [x, y] = legacy.split(',').map(part => Number.parseInt(part, 10));
    return Number.isInteger(x) && Number.isInteger(y) ? {ws: 0, x, y} : null;
}

/**
 * @param {Gio.File} file - the file to remember a position for
 * @param {number} ws - the workspace the icon belongs to
 * @param {number} x - global logical x
 * @param {number} y - global logical y
 */
export function writePosition(file, ws, x, y) {
    const info = new Gio.FileInfo();
    info.set_attribute_string(POSITION_ATTRIBUTE,
        `${ws},${Math.round(x)},${Math.round(y)}`);

    try {
        file.set_attributes_from_info(info, Gio.FileQueryInfoFlags.NONE, null);
    } catch (error) {
        printerr(`iconPositions: cannot save the position of ${file.get_basename()}: ${error.message}`);
    }
}

/**
 * @param {Gio.File} file - the file to forget
 */
export function clearPosition(file) {
    const info = new Gio.FileInfo();
    // Properly removing an attribute means setting it to type INVALID, and
    // Gio.FileInfo.set_attribute() is not introspectable from GJS. An empty
    // string is the next best thing: readPosition() rejects it, so the icon
    // counts as unplaced, and the leftover key costs nothing. Both attributes
    // are cleared — a legacy position would otherwise keep placing the icon
    // through the fallback read.
    info.set_attribute_string(POSITION_ATTRIBUTE, '');
    info.set_attribute_string(LEGACY_ATTRIBUTE, '');

    try {
        file.set_attributes_from_info(info, Gio.FileQueryInfoFlags.NONE, null);
    } catch (error) {
        printerr(`iconPositions: cannot clear the position of ${file.get_basename()}: ${error.message}`);
    }
}
