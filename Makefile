UUID = dock-stack@felipe.local
INSTALL_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
ZIP = $(UUID).shell-extension.zip

.PHONY: all schemas pack install enable disable clean

all: pack

# Compile the GSettings schemas
schemas: schemas/gschemas.compiled
schemas/gschemas.compiled: schemas/*.gschema.xml
	glib-compile-schemas schemas/

# Package the extension into a .zip ready to distribute/install
pack: schemas
	gnome-extensions pack --extra-source=systray.js --force .
	@echo "Generated: $(ZIP)"

# Install the .zip into the user's system
install: pack
	gnome-extensions install --force $(ZIP)
	@echo "Installed. Log out and back in (Wayland)."

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

clean:
	rm -f $(ZIP) schemas/gschemas.compiled
