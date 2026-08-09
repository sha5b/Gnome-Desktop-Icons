// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright 2026 Shahab Nedaei <ned.tabulov@gmail.com>
//
// "Open With" as a window: every application registered for the file's type,
// with one switch deciding whether the choice is for this once or for good.
//
// It is a plain toplevel, not a modal attached to the desktop window. The
// desktop is a WindowType.DESKTOP window pinned to the bottom of the stack, and
// anything made transient for it inherits that position — the dialog would open
// underneath every other window on screen.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {_, format, ngettext} from './gettext.js';

export const OpenWithDialog = GObject.registerClass(
class OpenWithDialog extends Adw.Window {
    _init(params) {
        const {item, onChoose, ...windowParams} = params;

        super._init({
            title: _('Open With'),
            default_width: 440,
            default_height: 520,
            ...windowParams,
        });

        this._item = item;
        this._onChoose = onChoose;
        this._applications = applicationsFor(item);

        const openButton = new Gtk.Button({label: _('Open'), css_classes: ['suggested-action']});
        openButton.connect('clicked', () => this._choose());
        this._openButton = openButton;

        const cancelButton = new Gtk.Button({label: _('Cancel')});
        cancelButton.connect('clicked', () => this.close());

        const header = new Adw.HeaderBar({show_end_title_buttons: false});
        header.pack_start(cancelButton);
        header.pack_end(openButton);

        const view = new Adw.ToolbarView();
        view.add_top_bar(header);
        view.set_content(this._buildBody());
        this.set_content(view);
    }

    _buildBody() {
        const page = new Adw.PreferencesPage();

        const group = new Adw.PreferencesGroup({
            title: format(_('Open “%s” with'), this._item.displayName),
        });

        this._rows = [];
        this._selected = null;
        this._defaultId = defaultIdFor(this._item);

        for (const application of this._applications)
            group.add(this._buildRow(application));

        if (this._applications.length === 0) {
            group.add(new Adw.ActionRow({
                title: _('Nothing is registered for this file type'),
                subtitle: _('Pick from every installed application below'),
                sensitive: false,
            }));
        }

        page.add(group);

        // Everything else that is installed, collapsed. A file type's
        // registered handlers are only ever a suggestion — sometimes the right
        // answer is a text editor on a video file — so the full list is one
        // click away rather than absent.
        const others = otherApplications(this._applications);
        if (others.length > 0) {
            const otherGroup = new Adw.PreferencesGroup();
            const expander = new Adw.ExpanderRow({
                title: _('All Applications'),
                subtitle: format(ngettext('%d more installed', '%d more installed', others.length), others.length),
            });

            for (const application of others)
                expander.add_row(this._buildRow(application));

            otherGroup.add(expander);
            page.add(otherGroup);
        }

        if (!this._selected && this._rows.length > 0)
            this._rows[0].check.set_active(true);
        else if (this._rows.length === 0)
            this._openButton.set_sensitive(false);

        const options = new Adw.PreferencesGroup();
        this._alwaysUse = new Adw.SwitchRow({
            title: _('Always Use for This File Type'),
            subtitle: _('Makes it the default and changes what a double-click does'),
        });
        options.add(this._alwaysUse);
        page.add(options);

        return page;
    }

    /**
     * @param {Gio.AppInfo} application - the application this row offers
     * @returns {Adw.ActionRow} the row, already wired into the radio group
     */
    _buildRow(application) {
        const row = new Adw.ActionRow({
            title: application.get_display_name(),
            subtitle: application.get_description() ?? '',
            activatable: true,
        });
        row.add_prefix(new Gtk.Image({gicon: application.get_icon(), pixel_size: 32}));

        const check = new Gtk.CheckButton();
        // One group across both lists, so the rows behave as one radio set.
        if (this._rows.length > 0)
            check.set_group(this._rows[0].check);
        row.add_suffix(check);
        row.set_activatable_widget(check);

        check.connect('toggled', () => {
            if (check.active)
                this._selected = application;
        });

        if (application.get_id() === this._defaultId) {
            check.set_active(true);
            this._selected = application;
        }

        this._rows.push({row, check, application});
        return row;
    }

    _choose() {
        if (!this._selected)
            return;

        this._onChoose(this._selected, this._alwaysUse.active);
        this.close();
    }
});

/**
 * @param {object} item - a FileModel item
 * @returns {Gio.AppInfo[]} everything registered for its type, best first
 */
export function applicationsFor(item) {
    const type = item.isDirectory ? 'inode/directory' : item.contentType;

    // GIO keeps three separate lists and none of them is complete on its own.
    // `recommended` is what registered for this exact type; `fallback` is what
    // registered for a parent type — which is where most media players live,
    // since a player declares video/x-matroska and not every subclass of it;
    // `all` is the union as the mimeapps files see it. Using only the first two
    // is why a video showed three players when a dozen were installed.
    const seen = new Set();
    return [
        ...Gio.AppInfo.get_recommended_for_type(type),
        ...Gio.AppInfo.get_fallback_for_type(type),
        ...Gio.AppInfo.get_all_for_type(type),
    ].filter(application => keepOnce(application, seen));
}

/**
 * Everything installed that is not already in the associated list. This is the
 * escape hatch for opening a file with something that never claimed its type —
 * a hex editor on a video, say.
 *
 * @param {Gio.AppInfo[]} associated - what applicationsFor() already returned
 * @returns {Gio.AppInfo[]} the rest, sorted by name
 */
export function otherApplications(associated) {
    const seen = new Set(associated.map(application => application.get_id()));

    return Gio.AppInfo.get_all()
        .filter(application => keepOnce(application, seen))
        .sort((a, b) => a.get_display_name().localeCompare(b.get_display_name()));
}

/**
 * @param {Gio.AppInfo} application - a candidate
 * @param {Set<string>} seen - ids already taken, added to as a side effect
 * @returns {boolean} whether to keep it
 */
function keepOnce(application, seen) {
    const id = application.get_id();
    if (!id || seen.has(id) || !application.should_show())
        return false;

    seen.add(id);
    return true;
}

/**
 * @param {object} item - a FileModel item
 * @returns {string} the id of the type's default application, or ""
 */
function defaultIdFor(item) {
    const type = item.isDirectory ? 'inode/directory' : item.contentType;
    return Gio.AppInfo.get_default_for_type(type, false)?.get_id() ?? '';
}
