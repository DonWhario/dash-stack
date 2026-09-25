# Dock Stack

Bottom dock for **GNOME Shell 48–50** (Wayland) with macOS-style application
groupings (*stacks*), a custom application grid (*Launchpad*), a taskbar with
running apps, and tray icons (*systray*) in the top panel.

> Personal extension of *Aplicaciones y Utilitarios — ABAZA*.

## Features

- **Configurable bottom dock** (icon size, opacity, position, reserved space).
- **macOS-style stacks**: groups of apps or folders that expand as a **grid** or
  a **fan** (curved strip), with ascending/descending order.
- **Unified order**: favorites and stacks are mixed and **reordered by dragging**,
  with a fluid animation (icons move aside to open the gap).
- **Running apps** in the dock, grouped per application, with indicator dots and
  window thumbnails on hover.
- **Custom application grid** (*Launchpad*) with categories, search, alphabetical
  sorting and a light/dark theme, replacing the GNOME *overview*.
- **Genie effect** when opening/closing the grid (grows/shrinks from the menu button).
- Own **systray** (StatusNotifierItem/AppIndicator) in the top panel.
- **Intellihide** and auto-hide; hides in fullscreen (games/video).
- Configurable **login/logout sounds**.
- **Multilingual UI**: Spanish, English, Portuguese, French and German (follows
  the system language, or a manual selector; falls back to English).
- **Burn My Windows integration**: the dock sets each window's minimize target to
  its dock icon, so Burn My Windows' *magic lamp* aims at the right icon.
- GNOME integration: disables Dash to Dock, hides the overview dash and the native
  applications button while active.
- **Preferences** panel (General / Stacks / About).

## Screenshot

![Dock Stack](screenshots/dock-stack.png)

## Requirements

- GNOME Shell **48–50**
- **Wayland** session (recommended)

## Installation

### From the package (.zip)

```bash
gnome-extensions install --force dock-stack@felipe.local.shell-extension.zip
```

Log out and back in, then enable it:

```bash
gnome-extensions enable dock-stack@felipe.local
```

### From source (cloning the repository)

```bash
git clone https://github.com/DonWhario/dash-stack.git \
  ~/.local/share/gnome-shell/extensions/dock-stack@felipe.local
cd ~/.local/share/gnome-shell/extensions/dock-stack@felipe.local
make schemas          # compile the GSettings schemas
gnome-extensions enable dock-stack@felipe.local
```

Log out and back in so GNOME Shell loads it.

## Development

```bash
make schemas   # compile schemas after editing the .gschema.xml
make pack      # build the .zip
make install   # package and install
```

Test without logging out (nested session):

```bash
dbus-run-session -- gnome-shell --nested --wayland
```

Live diagnostics:

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

## Structure

| File | Description |
|---|---|
| `extension.js`   | Main logic: dock, stacks, grid, intellihide, integration. |
| `systray.js`     | StatusNotifierItem/AppIndicator host for tray icons. |
| `prefs.js`       | Preferences panel (Adw). |
| `translations.js`| Built-in translations (es, en, pt, fr, de). |
| `stylesheet.css` | Styles for the dock, stacks, grid and thumbnails. |
| `schemas/`       | GSettings schema. |

## License

[MIT](LICENSE) © 2026 Felipe Abarca
