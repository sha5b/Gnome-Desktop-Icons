// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright 2026 Shahab Nedaei <ned.tabulov@gmail.com>
//
// Translations for the helper.
//
// The extension half gets this for free from `Extension.gettext`, but the
// helper is an ordinary process that knows nothing about the extension system,
// so it binds the domain itself. The catalogue lives beside the sources, in the
// extension's own locale/ directory, because an extension installed from
// extensions.gnome.org has nowhere else to put one.

import Gettext from 'gettext';

const DOMAIN = 'gnome-desktop-icons';

/**
 * @param {string} localeDir - the extension's locale/ directory
 */
export function initTranslations(localeDir) {
    Gettext.bindtextdomain(DOMAIN, localeDir);
    Gettext.textdomain(DOMAIN);
}

/**
 * @param {string} message - the English string, as written in the source
 * @returns {string} its translation, or the original if there is none
 */
export function _(message) {
    return Gettext.dgettext(DOMAIN, message);
}

/**
 * Substitute %s and %d placeholders.
 *
 * GJS used to add String.prototype.format through `imports.format`, which no
 * longer exists in an ES module. Translated strings still need placeholders —
 * a translator has to be able to move the name to the other end of the
 * sentence — so the substitution is done here instead.
 *
 * @param {string} template - a translated string containing %s or %d
 * @param {...any} values - what to put in them, in order
 * @returns {string} the finished string
 */
export function format(template, ...values) {
    let index = 0;
    return template.replace(/%[sd]/g, () => String(values[index++]));
}

/**
 * @param {string} singular - the English singular
 * @param {string} plural - the English plural
 * @param {number} count - how many
 * @returns {string} the correctly pluralised translation
 */
export function ngettext(singular, plural, count) {
    return Gettext.dngettext(DOMAIN, singular, plural, count);
}
