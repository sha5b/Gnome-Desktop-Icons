// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright 2026 Shahab Nedaei <ned.tabulov@gmail.com>
//
// Where each icon sits, remembered on the file itself.
//
// The position is stored in the file's `metadata::nautilus-icon-position`
// attribute as "x,y" — the same attribute and the same format the Nautilus
// desktop used, so a desktop laid out here keeps its arrangement if anything
// else ever reads it. GIO keeps these in its own metadata store, not in the
// file, so nothing is written to the user's documents.
//
// Coordinates are global logical pixels: the monitor's origin plus the offset
// within it. That single number pair says both where an icon is and which
// monitor it is on, and it degrades well — a position belonging to a monitor
// that is no longer attached simply fails the bounds test and the icon falls
// back to automatic placement.

import Gio from 'gi://Gio';

const ATTRIBUTE = 'metadata::nautilus-icon-position';

/**
 * @param {Gio.FileInfo} info - an entry, queried with metadata::*
 * @returns {?object} the saved {x, y}, or null if the icon has never been moved
 */
export function readPosition(info) {
    const raw = info.get_attribute_string(ATTRIBUTE);
    if (!raw)
        return null;

    const [x, y] = raw.split(',').map(part => Number.parseInt(part, 10));
    return Number.isInteger(x) && Number.isInteger(y) ? {x, y} : null;
}

/**
 * @param {Gio.File} file - the file to remember a position for
 * @param {number} x - global logical x
 * @param {number} y - global logical y
 */
export function writePosition(file, x, y) {
    const info = new Gio.FileInfo();
    info.set_attribute_string(ATTRIBUTE, `${Math.round(x)},${Math.round(y)}`);

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
    // counts as unplaced, and the leftover key costs nothing.
    info.set_attribute_string(ATTRIBUTE, '');

    try {
        file.set_attributes_from_info(info, Gio.FileQueryInfoFlags.NONE, null);
    } catch (error) {
        printerr(`iconPositions: cannot clear the position of ${file.get_basename()}: ${error.message}`);
    }
}
