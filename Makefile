# SPDX-License-Identifier: GPL-2.0-or-later

UUID           := desktop-icons-50@fiber-elements.com
SCHEMA_ID      := org.gnome.shell.extensions.desktop-icons-50
EXTENSIONS_DIR := $(HOME)/.local/share/gnome-shell/extensions
INSTALL_PATH   := $(EXTENSIONS_DIR)/$(UUID)

.PHONY: all schemas install uninstall lint check helper devkit pack clean

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

## Nested development shell. The session shell cannot be restarted on Wayland,
## so all iteration happens here. Watch logs with: journalctl --user -f
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
