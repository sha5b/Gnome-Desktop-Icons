// SPDX-License-Identifier: GPL-2.0-or-later
//
// Flat config based on the rules the GNOME Shell tree enforces on extensions.
// Install the tooling first: npm install

import js from '@eslint/js';
import jsdoc from 'eslint-plugin-jsdoc';

// Globals injected by GJS itself, plus the ones the shell adds in its process.
const gjsGlobals = {
    ARGV: 'readonly',
    Debugger: 'readonly',
    GIRepositoryGType: 'readonly',
    console: 'readonly',
    imports: 'readonly',
    log: 'readonly',
    logError: 'readonly',
    print: 'readonly',
    printerr: 'readonly',
    pkg: 'readonly',
};

export default [
    js.configs.recommended,
    jsdoc.configs['flat/recommended'],
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: gjsGlobals,
        },
        rules: {
            'arrow-parens': ['error', 'as-needed'],
            'brace-style': ['error', '1tbs', {allowSingleLine: true}],
            'camelcase': ['error', {properties: 'never', allow: ['^vfunc_', '^on_']}],
            'comma-dangle': ['error', 'always-multiline'],
            'curly': ['error', 'multi-or-nest', 'consistent'],
            'eqeqeq': 'error',
            'indent': ['error', 4, {
                SwitchCase: 0,
                CallExpression: {arguments: 1},
                // GObject.registerClass(class Foo extends Bar {…}) is written
                // with the class expression at column 0, the way the shell's
                // own sources write it. Only the node's own indent is ignored;
                // its body is still checked.
                ignoredNodes: ['CallExpression > ClassExpression.arguments'],
            }],
            'no-restricted-properties': ['error',
                {object: 'Lang', message: 'Use ES6 classes and arrow functions'},
                {object: 'Mainloop', message: 'Use GLib timeout/idle sources'},
            ],
            'no-restricted-globals': ['error',
                {name: 'ByteArray', message: 'Use TextEncoder/TextDecoder'},
            ],
            'no-unused-vars': ['error', {argsIgnorePattern: '^_'}],
            'prefer-const': 'error',
            'quotes': ['error', 'single', {avoidEscape: true}],
            'semi': ['error', 'always'],
            'jsdoc/require-jsdoc': 'off',
            // Every GI namespace (Meta, Mtk, Gio…) is "undefined" to jsdoc, and
            // a blank line between description and tags is how the shell's
            // sources are written.
            'jsdoc/no-undefined-types': 'off',
            'jsdoc/tag-lines': 'off',
        },
    },
    {
        // The shell process must never see GTK, and prefs must never see the
        // compositor. Enforced here as well as by review.
        files: ['extension.js', 'src/**/*.js'],
        languageOptions: {
            // `global` is injected by the shell into its own process only.
            globals: {global: 'readonly'},
        },
        rules: {
            'no-restricted-imports': ['error', {
                patterns: [{
                    group: ['gi://Gtk*', 'gi://Gdk*', 'gi://Adw*'],
                    message: 'GTK belongs in the helper process, never in gnome-shell',
                }],
            }],
        },
    },
    {
        files: ['prefs.js'],
        rules: {
            'no-restricted-imports': ['error', {
                patterns: [{
                    group: ['gi://Clutter*', 'gi://Meta*', 'gi://St*', 'gi://Shell*'],
                    message: 'prefs.js runs outside gnome-shell',
                }],
            }],
        },
    },
    {
        files: ['helper/**/*.js'],
        languageOptions: {
            globals: gjsGlobals,
        },
    },
];
