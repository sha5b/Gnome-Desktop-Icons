// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright 2026 Shahab Nedaei <ned.tabulov@gmail.com>
//
// Constants of the protocol between the shell process and the helper process.
// This module is imported by BOTH processes, so it must never import any
// `gi://` module.

export const TITLE_PREFIX = 'gnome-desktop-icons:';

// The file metadata attribute holding an icon's position, as "ws,x,y": the
// workspace the icon belongs to, then its spot in global logical pixels.
// Positions saved before icons were per-workspace live in
// metadata::nautilus-icon-position as "x,y" and are read as workspace 0.
export const POSITION_ATTRIBUTE = 'metadata::gnome-desktop-icons-position';
