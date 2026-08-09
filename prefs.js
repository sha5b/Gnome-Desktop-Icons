// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright 2026 Shahab Nedaei <ned.tabulov@gmail.com>
//
// Preferences. This file runs in its own process, outside gnome-shell, so it
// must never import Clutter, Meta, St or Shell.
//
// There is very little here on purpose. Everything else the desktop does is
// taken from settings the user has already made elsewhere: the click policy
// comes from Files, the wallpaper and scaling from Settings, the icons from the
// icon theme. Duplicating those here would only let the two disagree.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const ICON_SIZES = [
    {value: 'small', title: 'Small'},
    {value: 'standard', title: 'Standard'},
    {value: 'large', title: 'Large'},
];

export default class GnomeDesktopIconsPreferences extends ExtensionPreferences {
    /**
     * @param {Adw.PreferencesWindow} window - the window to fill
     */
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'Desktop',
            icon_name: 'user-desktop-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: 'Icons',
            description: 'Click behaviour follows Files, so the desktop and ' +
                'file windows always agree.',
        });

        const iconSize = new Adw.ComboRow({
            title: 'Icon Size',
            model: Gtk.StringList.new(ICON_SIZES.map(size => size.title)),
            selected: indexOfValue(settings.get_string('icon-size')),
        });
        iconSize.connect('notify::selected', row =>
            settings.set_string('icon-size', ICON_SIZES[row.selected].value));
        group.add(iconSize);

        const showHidden = new Adw.SwitchRow({
            title: 'Show Hidden Files',
            subtitle: 'Files whose name begins with a dot',
        });
        settings.bind('show-hidden', showHidden, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        group.add(showHidden);

        page.add(group);
        window.add(page);
    }
}

/**
 * @param {string} value - a stored icon-size nick
 * @returns {number} its position in the combo, defaulting to Standard
 */
function indexOfValue(value) {
    const index = ICON_SIZES.findIndex(size => size.value === value);
    return index < 0 ? 1 : index;
}
