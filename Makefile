UUID = dock-stack@felipe.local
INSTALL_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
ZIP = $(UUID).shell-extension.zip

.PHONY: all schemas pack install enable disable clean

all: pack

# Compilar los esquemas de GSettings
schemas: schemas/gschemas.compiled
schemas/gschemas.compiled: schemas/*.gschema.xml
	glib-compile-schemas schemas/

# Empaquetar la extensión en un .zip listo para distribuir/instalar
pack: schemas
	gnome-extensions pack --extra-source=systray.js --force .
	@echo "Generado: $(ZIP)"

# Instalar el .zip en el sistema del usuario
install: pack
	gnome-extensions install --force $(ZIP)
	@echo "Instalado. Cierra sesión y vuelve a entrar (Wayland)."

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

clean:
	rm -f $(ZIP) schemas/gschemas.compiled
