# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright 2026 Shahab Nedaei <ned.tabulov@gmail.com>

UUID           := gnome-desktop-icons@ned.tabulov.gmail.com
SCHEMA_ID      := org.gnome.shell.extensions.gnome-desktop-icons
GETTEXT_DOMAIN := gnome-desktop-icons
EXTENSIONS_DIR := $(HOME)/.local/share/gnome-shell/extensions
INSTALL_PATH   := $(EXTENSIONS_DIR)/$(UUID)

.PHONY: all schemas install uninstall lint check helper run devkit pot pack clean

all: schemas

## Compile the GSettings schema in place, so the symlinked tree is usable.
schemas: schemas/gschemas.compiled

schemas/gschemas.compiled: schemas/$(SCHEMA_ID).gschema.xml
	glib-compile-schemas schemas

## Symlink this checkout into the extensions directory; edits take effect on
## the next shell restart or extension re-enable, with no copying.
install: schemas
	mkdir -p $(EXTENSIONS_DIR)
	rm -rf $(INSTALL_PATH)
	ln -sfn $(CURDIR) $(INSTALL_PATH)
	@echo "$(INSTALL_PATH) -> $(CURDIR)"

uninstall:
	rm -rf $(INSTALL_PATH)

lint:
	npx --no-install eslint .

## Parse every source file as an ES module without a shell. Catches syntax
## errors before they reach the journal, where a broken extension is only
## reported as "failed to load". Does not resolve imports.
check:
	@tmp=$$(mktemp -d); status=0; \
	for f in extension.js src/*.js helper/*.js; do \
		cp "$$f" "$$tmp/check.mjs"; \
		node --check "$$tmp/check.mjs" || { echo "  in $$f"; status=1; }; \
	done; \
	rm -rf "$$tmp"; \
	test $$status -eq 0 && echo "syntax ok"; exit $$status

## Run the helper on its own, outside the shell, for GTK-side debugging.
helper:
	gjs -m helper/main.js

## Run it in a nested shell WITHOUT installing anything.
##
## Everything lives in a throwaway profile: its own XDG_DATA_HOME holding a
## symlink to this checkout, its own settings, its own session bus. Your real
## ~/.local/share and your real extension list are never touched, and the whole
## profile is deleted when the shell exits. Needs: sudo dnf install mutter-devkit
##
##   make run              plain
##   make run DEBUG=1      with lifecycle tracing on stderr
##
## The thumbnail cache is shared with the real session on purpose, so a test run
## does not regenerate every thumbnail from scratch. Your real ~/.local/share is
## added to XDG_DATA_DIRS, read-only, so Flatpak applications and installed icon
## themes are still found; only `enabled-extensions` in the scratch profile
## decides what loads, so none of your other extensions come along.
run: schemas
	@profile=$$(mktemp -d /tmp/$(UUID).XXXXXX); \
	mkdir -p $$profile/data/gnome-shell/extensions $$profile/config/glib-2.0/settings; \
	ln -sfn $(CURDIR) $$profile/data/gnome-shell/extensions/$(UUID); \
	{ echo "[org/gnome/shell]"; \
	  echo "enabled-extensions=['$(UUID)']"; \
	  echo "disable-user-extensions=false"; \
	  echo "welcome-dialog-last-shown-version='50.4'"; } \
	  > $$profile/config/glib-2.0/settings/keyfile; \
	echo "scratch profile: $$profile"; \
	XDG_DATA_HOME=$$profile/data \
	XDG_DATA_DIRS=$(HOME)/.local/share:$${XDG_DATA_DIRS:-/usr/local/share:/usr/share} \
	XDG_CONFIG_HOME=$$profile/config \
	XDG_CACHE_HOME=$(HOME)/.cache \
	GSETTINGS_BACKEND=keyfile \
	GNOME_DESKTOP_ICONS_DEBUG=$(DEBUG) \
	dbus-run-session -- gnome-shell --devkit --wayland --wayland-display=$(UUID); \
	rm -rf $$profile; \
	echo "scratch profile removed"

## Same, but against the installed copy in your real profile.
devkit: install
	SHELL_DEBUG=all G_MESSAGES_DEBUG=all \
		dbus-run-session -- gnome-shell --devkit --wayland

pack: schemas
	gnome-extensions pack --force \
		--extra-source=src \
		--extra-source=helper \
		--extra-source=data \
		--schema=schemas/$(SCHEMA_ID).gschema.xml

clean:
	rm -f schemas/gschemas.compiled $(UUID).shell-extension.zip

## Extract translatable strings into locale/gnome-desktop-icons.pot.
pot:
	xgettext --from-code=UTF-8 --language=JavaScript \
		--keyword=_ --keyword=ngettext:1,2 \
		--package-name="Gnome Desktop Icons" \
		--copyright-holder="Shahab Nedaei" \
		--output=locale/$(GETTEXT_DOMAIN).pot \
		$$(git ls-files 'helper/*.js' 'src/*.js' extension.js prefs.js)
	@echo "wrote locale/$(GETTEXT_DOMAIN).pot"
