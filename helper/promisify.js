// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright 2026 Shahab Nedaei <ned.tabulov@gmail.com>
//
// GJS does not turn async GIO methods into promises on its own, so every one we
// await is registered here. Import this module for its side effect from any
// file that awaits GIO; ES modules run once, and always before their importers,
// so the registration is guaranteed to have happened.

import Gio from 'gi://Gio';
import GnomeDesktop from 'gi://GnomeDesktop?version=4.0';

Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.File.prototype, 'make_directory_async');
Gio._promisify(Gio.File.prototype, 'trash_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.DBusConnection.prototype, 'call');

Gio._promisify(GnomeDesktop.DesktopThumbnailFactory.prototype, 'generate_thumbnail_async');
Gio._promisify(GnomeDesktop.DesktopThumbnailFactory.prototype, 'save_thumbnail_async');
Gio._promisify(GnomeDesktop.DesktopThumbnailFactory.prototype, 'create_failed_thumbnail_async');
