/* Dock Stacks — GNOME Shell 48
 * Dock inferior con agrupaciones de aplicaciones estilo macOS (stacks).
 */

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {SysTrayManager} from './systray.js';

const APP_SYSTEM = () => Shell.AppSystem.get_default();

// ------------------------------------------------------------------ helpers
function safeParseStacks(str) {
    try {
        const v = JSON.parse(str);
        return Array.isArray(v) ? v : [];
    } catch (_e) {
        return [];
    }
}

function iconForGicon(gicon, size) {
    return new St.Icon({gicon, icon_size: size});
}

// ------------------------------------------------------------- DockItemButton
const DockItemButton = GObject.registerClass(
class DockItemButton extends St.Button {
    _init(iconActor, label, iconSize) {
        super._init({
            style_class: 'dock-item',
            reactive: true,
            can_focus: true,
            track_hover: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._iconSize = iconSize;
        this._box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_align: Clutter.ActorAlign.CENTER});
        if (iconActor)
            this._box.add_child(iconActor);
        // Fila de puntos indicadores de ejecución (debajo del icono)
        this._indicator = new St.BoxLayout({
            style_class: 'dock-running-indicator',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._box.add_child(this._indicator);
        this.set_child(this._box);
        if (label)
            this.set_tooltip_text?.(label); // no-op si no existe; usamos hover propio
        this._labelText = label;
    }

    setRunning(windowCount, focused) {
        this._indicator.destroy_all_children();
        if (!windowCount || windowCount <= 0)
            return;
        const dots = Math.min(windowCount, 3); // agrupado: 1..3 puntos
        for (let i = 0; i < dots; i++) {
            const dot = new St.Widget({style_class: 'dock-running-dot'});
            if (focused)
                dot.add_style_class_name('focused');
            this._indicator.add_child(dot);
        }
    }
});

// ---------------------------------------------------------------- StackPopup
const StackPopup = GObject.registerClass(
class StackPopup extends St.BoxLayout {
    _init(title) {
        super._init({
            style_class: 'dock-stack-popup',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
        });
        if (title) {
            const header = new St.Label({style_class: 'dock-stack-title', text: title});
            this.add_child(header);
        }
        this._grid = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'dock-stack-grid'});
        this.add_child(this._grid);
    }

    setEntries(entries, columns, iconSize, onActivate) {
        this._grid.destroy_all_children();
        this._cells = [];
        let row = null;
        entries.forEach((entry, i) => {
            if (i % columns === 0) {
                row = new St.BoxLayout({style_class: 'dock-stack-row'});
                this._grid.add_child(row);
            }
            const cell = new St.Button({style_class: 'dock-stack-cell', can_focus: true});
            const cbox = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_align: Clutter.ActorAlign.CENTER});
            cbox.add_child(iconForGicon(entry.gicon, iconSize));
            const lbl = new St.Label({style_class: 'dock-stack-cell-label', text: entry.name});
            lbl.clutter_text.set_line_wrap(true);
            lbl.clutter_text.set_ellipsize(3 /* PANGO_ELLIPSIZE_END */);
            cbox.add_child(lbl);
            cell.set_child(cbox);
            cell.connect('clicked', () => onActivate(entry));
            row.add_child(cell);
            this._cells.push(cell);
        });
        if (entries.length === 0) {
            const empty = new St.Label({style_class: 'dock-stack-cell-label', text: '(vacío)'});
            this._grid.add_child(empty);
        }
    }

    getCells() {
        return this._cells || [];
    }
});

// ------------------------------------------------------------------ Extension
export default class DockStacksExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._stackOverlay = null;
        this._stackPopup = null;
        this._stackGrab = null;
        this._relayoutId = 0;
        this._winSignals = [];   // [ [app, handlerId], ... ]
        this._dragActive = false;
        this._pendingRebuild = false;
        this._reorderCtx = null;

        this._buildDock();
        this._applyGnomeIntegration();
        this._applySysTray();
        this._playStartupSound();

        // Reaccionar a cambios de configuración
        this._settingsChangedId = this._settings.connect('changed', (_s, key) => {
            if (key === 'stacks' || key === 'show-favorites' || key === 'icon-size' ||
                key === 'show-apps-button' || key === 'apps-button-icon' ||
                key === 'apps-button-position' || key === 'show-running' ||
                key === 'running-indicators' || key === 'window-previews' ||
                key === 'dock-order')
                this._rebuildItems();
            else if (key === 'position' || key === 'background-opacity')
                this._applyStyle();
            else if (key === 'autohide' || key === 'intellihide')
                this._applyAutohide();
            else if (key === 'reserve-space')
                this._applyReserveSpace();
            else if (key === 'disable-dash-to-dock' || key === 'hide-overview-dash' ||
                key === 'enable-appindicator')
                this._applyGnomeIntegration();
            else if (key === 'systray')
                this._applySysTray();
        });

        // Reaccionar a cambios de favoritos / apps instaladas
        this._favChangedId = AppFavorites.getAppFavorites().connect('changed', () => this._rebuildItems());

        // Reaccionar a apps que arrancan / se cierran y al foco
        this._appStateId = Shell.AppSystem.get_default().connect(
            'app-state-changed', () => this._queueRebuild());
        this._focusAppId = Shell.WindowTracker.get_default().connect(
            'notify::focus-app', () => this._queueRebuild());

        // Recalcular visibilidad (intellihide) ante cambios de ventanas.
        // Con debounce: al maximizar se disparan muchos 'size-changed' y el
        // solape "parpadea"; agrupándolos evitamos alternancias que dejan el dock a medias.
        this._visSignals = [];
        const watchVis = (obj, sig) =>
            this._visSignals.push([obj, obj.connect(sig, () => this._scheduleVisibility())]);
        watchVis(global.window_manager, 'size-changed');
        watchVis(global.window_manager, 'minimize');
        watchVis(global.window_manager, 'unminimize');
        watchVis(global.window_manager, 'map');
        watchVis(global.window_manager, 'destroy');
        watchVis(global.display, 'notify::focus-window');
        watchVis(global.workspace_manager, 'active-workspace-changed');
        watchVis(global.display, 'in-fullscreen-changed');
        watchVis(Main.overview, 'showing');
        watchVis(Main.overview, 'hidden');

        // Reconstruir el dock cuando aparece una ventana nueva
        // (para actualizar la sección de apps en ejecución). El cierre de apps
        // lo cubre 'app-state-changed'. Evitamos 'map'/'destroy' por ventana
        // para no provocar avalanchas de reconstrucción.
        this._visSignals.push([global.display,
            global.display.connect('window-created', () => this._queueRebuild())]);

        // Reposicionar en cambios de monitor
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._relayout());
    }

    _queueRebuild() {
        if (this._dragActive) {
            this._pendingRebuild = true;
            return;
        }
        if (this._rebuildQueued)
            return;
        this._rebuildQueued = true;
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._rebuildQueued = false;
            if (this._dock)
                this._rebuildItems();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearWinSignals() {
        if (!this._winSignals)
            return;
        for (const [app, id] of this._winSignals) {
            try {
                app.disconnect(id);
            } catch (_e) { /* ignore */ }
        }
        this._winSignals = [];
    }

    _watchApp(app) {
        const id = app.connect('windows-changed', () => this._queueRebuild());
        this._winSignals.push([app, id]);
    }

    // Apps en ejecución derivadas de las ventanas reales (más fiable que
    // AppSystem.get_running(), que puede omitir apps cuyo .desktop no casa).
    _getRunningApps() {
        const tracker = Shell.WindowTracker.get_default();
        const seen = new Set();
        const apps = [];
        // Tipos de ventana que representan aplicaciones (no diálogos/menús/etc.)
        const okTypes = [
            Meta.WindowType.NORMAL,
            Meta.WindowType.DIALOG,
            Meta.WindowType.MODAL_DIALOG,
        ];
        for (const actor of global.get_window_actors()) {
            const win = actor.get_meta_window ? actor.get_meta_window() : actor.meta_window;
            if (!win)
                continue;
            // Incluir todas las ventanas de aplicación (aunque marquen skip-taskbar,
            // como algunos juegos p. ej. Minecraft); excluir solo tipos auxiliares.
            if (!okTypes.includes(win.get_window_type()))
                continue;
            const app = tracker.get_window_app(win);
            if (!app)
                continue;
            const id = app.get_id();
            if (seen.has(id))
                continue;
            seen.add(id);
            apps.push(app);
        }
        // Incluir también lo que AppSystem considere en ejecución, por si acaso
        for (const app of Shell.AppSystem.get_default().get_running()) {
            const id = app.get_id();
            if (!seen.has(id)) {
                seen.add(id);
                apps.push(app);
            }
        }
        apps.sort((a, b) => a.get_name().localeCompare(b.get_name()));
        return apps;
    }

    // Activar / ciclar ventanas de una app en ejecución
    _activateApp(app) {
        this._closeAppGrid();
        if (Main.overview.visible)
            Main.overview.hide();
        const windows = app.get_windows();
        if (windows.length === 0) {
            app.activate();
            return;
        }
        const focusApp = Shell.WindowTracker.get_default().focus_app;
        if (focusApp === app && windows.length > 1) {
            // Ciclar a la siguiente ventana
            const active = global.display.get_focus_window();
            let idx = windows.indexOf(active);
            const next = windows[(idx + 1) % windows.length];
            Main.activateWindow(next);
        } else {
            app.activate();
        }
    }

    disable() {
        this._playShutdownSound();
        if (this._sysTray) {
            this._sysTray.disable();
            this._sysTray = null;
        }
        this._closeStack();
        this._revertGnomeIntegration();
        this._cancelPreviewTimers();
        this._destroyPreview();
        this._hideTooltip();
        this._closeAppGrid();
        if (this._geomIdle) {
            GLib.source_remove(this._geomIdle);
            this._geomIdle = 0;
        }
        if (this._visTimeout) {
            GLib.source_remove(this._visTimeout);
            this._visTimeout = 0;
        }

        if (this._itemMenu) {
            this._itemMenu.destroy();
            this._itemMenu = null;
        }
        if (this._menuManager) {
            this._menuManager = null;
        }

        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        if (this._favChangedId) {
            AppFavorites.getAppFavorites().disconnect(this._favChangedId);
            this._favChangedId = 0;
        }
        if (this._appStateId) {
            Shell.AppSystem.get_default().disconnect(this._appStateId);
            this._appStateId = 0;
        }
        if (this._focusAppId) {
            Shell.WindowTracker.get_default().disconnect(this._focusAppId);
            this._focusAppId = 0;
        }
        if (this._visSignals) {
            for (const [obj, id] of this._visSignals) {
                try {
                    obj.disconnect(id);
                } catch (_e) { /* ignore */ }
            }
            this._visSignals = [];
        }
        this._cancelHideTimer();
        this._clearWinSignals();
        if (this._monitorsId) {
            Main.layoutManager.disconnect(this._monitorsId);
            this._monitorsId = 0;
        }
        if (this._hotEdge) {
            Main.layoutManager.removeChrome(this._hotEdge);
            this._hotEdge.destroy();
            this._hotEdge = null;
        }
        if (this._container) {
            Main.layoutManager.removeChrome(this._container);
            this._container.destroy();
            this._container = null;
        }
        this._dock = null;
        this._settings = null;
    }

    // Host de bandeja (systray) en el panel superior
    _applySysTray() {
        const on = this._settings.get_boolean('systray');
        if (on && !this._sysTray) {
            try {
                this._sysTray = new SysTrayManager(this.uuid);
                this._sysTray.enable();
            } catch (e) {
                logError(e, 'Dock Stack: no se pudo iniciar el systray');
                this._sysTray = null;
            }
        } else if (!on && this._sysTray) {
            this._sysTray.disable();
            this._sysTray = null;
        }
    }

    // Sonido al cargar la extensión (configurable)
    _playStartupSound() {
        if (!this._settings.get_boolean('startup-sound'))
            return;
        const path = this._settings.get_string('startup-sound-file');
        if (path) {
            // Un reproductor externo soporta MP3/OGG/WAV/FLAC…
            if (this._playFileExternal(path))
                return;
            // Respaldo: reproductor de GNOME (solo OGG/WAV/FLAC)
            try {
                global.display.get_sound_player().play_from_file(
                    Gio.File.new_for_path(path), 'Dock Stack', null);
            } catch (e) {
                logError(e, 'Dock Stack: no se pudo reproducir el sonido de inicio');
            }
        } else {
            try {
                global.display.get_sound_player().play_from_theme(
                    'service-login', 'Dock Stack', null);
            } catch (_e) { /* ignore */ }
        }
    }

    // Sonido al cerrar la sesión (best-effort: el audio se cierra al salir)
    _playShutdownSound() {
        if (!this._settings.get_boolean('shutdown-sound'))
            return;
        // Omitir cuando solo se bloquea la pantalla (no es cierre de sesión)
        if (Main.sessionMode.currentMode === 'unlock-dialog')
            return;
        const path = this._settings.get_string('shutdown-sound-file');
        if (path) {
            // Desacoplado (setsid) para sobrevivir al cierre del shell un instante
            this._playFileExternal(path, true);
        } else {
            try {
                global.display.get_sound_player().play_from_theme(
                    'desktop-logout', 'Dock Stack', null);
            } catch (_e) { /* ignore */ }
        }
    }

    // Reproduce un archivo de audio con el primer reproductor disponible.
    // detached=true lo lanza en una sesión nueva (setsid) para que no muera con el shell.
    _playFileExternal(path, detached = false) {
        const candidates = [
            ['pw-play', [path]],
            ['paplay', [path]],
            ['ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', path]],
            ['mpv', ['--no-video', '--really-quiet', path]],
            ['gst-play-1.0', ['--no-interactive', path]],
            ['canberra-gtk-play', ['-f', path]],
        ];
        const setsid = detached ? GLib.find_program_in_path('setsid') : null;
        for (const [bin, args] of candidates) {
            const full = GLib.find_program_in_path(bin);
            if (!full)
                continue;
            try {
                if (detached) {
                    // Lanzar en sesión nueva para que sobreviva al cierre del shell
                    const argv = setsid ? [setsid, full, ...args] : [full, ...args];
                    GLib.spawn_async(null, argv, null,
                        GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.STDOUT_TO_DEV_NULL |
                        GLib.SpawnFlags.STDERR_TO_DEV_NULL, null);
                } else {
                    Gio.Subprocess.new(
                        [full, ...args],
                        Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
                }
                return true;
            } catch (e) {
                logError(e, `Dock Stack: fallo al reproducir con ${bin}`);
            }
        }
        return false;
    }

    // -------------------------------------------------- integración con GNOME
    _applyGnomeIntegration() {
        // 1) Desactivar Dash to Dock si procede
        const wantDisableDTD = this._settings.get_boolean('disable-dash-to-dock');
        const DTD = 'dash-to-dock@micxgx.gmail.com';
        const em = Main.extensionManager;
        if (wantDisableDTD) {
            const ext = em?.lookup(DTD);
            if (ext && ext.state === 1 /* ACTIVE */ && !this._disabledDTD) {
                this._disabledDTD = true;
                // Diferir para evitar reentrada durante enable()
                this._dtdTimeout = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    this._dtdTimeout = 0;
                    try {
                        em.disableExtension(DTD);
                    } catch (e) {
                        logError(e, 'Dock Stack: no se pudo desactivar Dash to Dock');
                    }
                    return GLib.SOURCE_REMOVE;
                });
            }
        } else if (this._disabledDTD) {
            this._disabledDTD = false;
            try {
                em.enableExtension(DTD);
            } catch (_e) { /* ignore */ }
        }

        // 2) Ocultar / mostrar el dash nativo de Actividades (incluye botón de apps)
        const wantHideDash = this._settings.get_boolean('hide-overview-dash');
        const dash = Main.overview?.dash;
        if (wantHideDash) {
            if (dash && !this._dashHidden) {
                this._dashHidden = true;
                this._savedDashWidth = dash.width;
                dash.hide();
                dash.width = 0;
                this._overviewShowingId = Main.overview.connect('showing', () => {
                    if (this._dashHidden && Main.overview.dash) {
                        Main.overview.dash.hide();
                        Main.overview.dash.width = 0;
                    }
                });
            }
        } else if (this._dashHidden) {
            this._revertDash();
        }

        // 3) Mantener activa la extensión AppIndicator (systray en el top bar)
        if (this._settings.get_boolean('enable-appindicator')) {
            const AI = 'appindicatorsupport@rgcjonas.gmail.com';
            const ext = em?.lookup(AI);
            if (ext && ext.state !== 1 /* no ACTIVE */) {
                this._aiTimeout = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    this._aiTimeout = 0;
                    try {
                        em.enableExtension(AI);
                    } catch (e) {
                        logError(e, 'Dock Stack: no se pudo activar AppIndicator');
                    }
                    return GLib.SOURCE_REMOVE;
                });
            }
        }
    }

    _revertDash() {
        if (!this._dashHidden)
            return;
        this._dashHidden = false;
        if (this._overviewShowingId) {
            Main.overview.disconnect(this._overviewShowingId);
            this._overviewShowingId = 0;
        }
        const dash = Main.overview?.dash;
        if (dash) {
            dash.set_width(-1); // volver a ancho automático
            dash.show();
        }
    }

    _revertGnomeIntegration() {
        if (this._dtdTimeout) {
            GLib.source_remove(this._dtdTimeout);
            this._dtdTimeout = 0;
        }
        if (this._aiTimeout) {
            GLib.source_remove(this._aiTimeout);
            this._aiTimeout = 0;
        }
        // Rehabilitar Dash to Dock si nosotros lo desactivamos
        if (this._disabledDTD) {
            this._disabledDTD = false;
            try {
                Main.extensionManager?.enableExtension('dash-to-dock@micxgx.gmail.com');
            } catch (_e) { /* ignore */ }
        }
        this._revertDash();
    }

    // ---------------------------------------------------------------- build
    _buildDock() {
        this._dock = new St.BoxLayout({
            style_class: 'dock-bar',
            orientation: this._isVertical()
                ? Clutter.Orientation.VERTICAL
                : Clutter.Orientation.HORIZONTAL,
            reactive: true,
            track_hover: true,
        });

        this._container = new St.Bin({
            child: this._dock,
            reactive: false,
        });

        this._strutsActive = this._settings.get_boolean('reserve-space');
        Main.layoutManager.addChrome(this._container, {
            affectsStruts: this._strutsActive,
            trackFullscreen: true,
        });

        // El dock actúa como objetivo de arrastre para reordenar
        this._dock._delegate = this;

        this._dock.connect('notify::width', () => this._relayout());
        this._dock.connect('notify::height', () => this._relayout());

        // autohide: mostrar al entrar, ocultar al salir
        this._dock.connect('enter-event', () => this._onHover(true));
        this._dock.connect('leave-event', () => this._onHover(false));

        this._applyStyle();
        this._rebuildItems();
        this._applyAutohide();
        this._relayout();
    }

    _isVertical() {
        const pos = this._settings.get_string('position');
        return pos === 'left' || pos === 'right';
    }

    // ----------------------------------------------------------- items
    _rebuildItems() {
        if (!this._dock)
            return;
        this._clearWinSignals();
        this._destroyPreview();
        this._hideTooltip();
        // Desactivar reactividad antes de destruir para que no se disparen
        // eventos enter/leave sobre actores en proceso de destrucción.
        for (const child of this._dock.get_children())
            child.reactive = false;
        this._dock.destroy_all_children();
        this._appButtonList = [];   // {app, btn} para geometría de minimizado
        const iconSize = this._settings.get_int('icon-size');

        const showRunning = this._settings.get_boolean('show-running');
        const showIndicators = this._settings.get_boolean('running-indicators');
        const previews = this._settings.get_boolean('window-previews');
        const focusApp = Shell.WindowTracker.get_default().focus_app;
        const runningApps = this._getRunningApps();

        // Botón de menú de aplicaciones (al inicio)
        const showApps = this._settings.get_boolean('show-apps-button');
        const appsAtStart = this._settings.get_string('apps-button-position') === 'start';
        if (showApps && appsAtStart) {
            this._dock.add_child(this._makeAppsButton(iconSize));
            const sep = new St.Widget({style_class: 'dock-separator'});
            this._dock.add_child(sep);
        }

        // ---- Elementos anclados: favoritos y stacks en un ORDEN UNIFICADO ----
        // Se pueden reordenar y MEZCLAR libremente entre sí (sin separación).
        const favIds = new Set();
        const pinned = this._computePinnedEntries();
        this._pinnedTokens = pinned.map(e => e.token);
        pinned.forEach((entry, index) => {
            if (entry.kind === 'fav') {
                const app = entry.app;
                favIds.add(app.get_id());
                const icon = app.create_icon_texture(iconSize);
                const btn = new DockItemButton(icon, app.get_name(), iconSize);
                btn.connect('clicked', () => this._activateApp(app));
                this._attachTooltip(btn, app.get_name());
                this._makeReorderable(btn, 'pinned', index, {token: entry.token});
                this._attachContextMenu(btn, () => {
                    const entries = [];
                    if (app.get_n_windows() > 0)
                        entries.push({label: 'Cerrar', callback: () => this._deferred(() => this._quitApp(app))});
                    entries.push({label: 'Quitar del dock', callback: () =>
                        this._deferred(() => AppFavorites.getAppFavorites().removeFavorite(app.get_id()))});
                    return entries;
                });
                this._dock.add_child(btn);
                this._appButtonList.push({app, btn});
                const wc = app.get_n_windows();
                if (wc > 0) {
                    if (showIndicators)
                        btn.setRunning(wc, app === focusApp);
                    if (previews)
                        this._attachWindowPreview(btn, app);
                    this._watchApp(app);
                }
            } else {
                const stack = entry.stack;
                const icon = this._stackIcon(stack, iconSize);
                const btn = new DockItemButton(icon, stack.name, iconSize);
                btn.connect('clicked', () => this._toggleStack(stack, btn));
                this._attachTooltip(btn, stack.name);
                this._makeReorderable(btn, 'pinned', index, {token: entry.token});
                this._attachContextMenu(btn, () => ([
                    {label: 'Editar en preferencias…', callback: () => this.openPreferences()},
                    {separator: true},
                    {label: 'Eliminar del dock', callback: () =>
                        this._deferred(() => this._removeStack(stack.id))},
                ]));
                this._dock.add_child(btn);
            }
        });

        // Apps en ejecución NO favoritas (agrupadas: un icono por app)
        if (showRunning) {
            const others = runningApps.filter(a => !favIds.has(a.get_id()));
            if (others.length && this._dock.get_n_children() > 0) {
                const sep = new St.Widget({style_class: 'dock-separator'});
                this._dock.add_child(sep);
            }
            for (const app of others) {
                const icon = app.create_icon_texture(iconSize);
                const btn = new DockItemButton(icon, app.get_name(), iconSize);
                btn.add_style_class_name('dock-running-item');
                btn.connect('clicked', () => this._activateApp(app));
                this._attachTooltip(btn, app.get_name());
                this._attachContextMenu(btn, () => ([
                    {label: 'Anclar a favoritos', callback: () =>
                        this._deferred(() => AppFavorites.getAppFavorites().addFavorite(app.get_id()))},
                    {separator: true},
                    {label: 'Cerrar', callback: () => this._deferred(() => this._quitApp(app))},
                ]));
                this._dock.add_child(btn);
                this._appButtonList.push({app, btn});
                if (showIndicators)
                    btn.setRunning(app.get_n_windows(), app === focusApp);
                if (previews)
                    this._attachWindowPreview(btn, app);
                this._watchApp(app);
            }
        }

        // Botón de menú de aplicaciones (al final)
        if (showApps && !appsAtStart) {
            if (this._dock.get_n_children() > 0) {
                const sep = new St.Widget({style_class: 'dock-separator'});
                this._dock.add_child(sep);
            }
            this._dock.add_child(this._makeAppsButton(iconSize));
        }

        this._relayout();
    }

    _makeAppsButton(iconSize) {
        let gicon;
        const spec = this._settings.get_string('apps-button-icon');
        try {
            gicon = Gio.icon_new_for_string(
                spec || 'view-app-grid-symbolic');
        } catch (_e) {
            gicon = new Gio.ThemedIcon({name: 'view-app-grid-symbolic'});
        }
        const icon = new St.Icon({gicon, icon_size: iconSize});
        const btn = new DockItemButton(icon, 'Aplicaciones', iconSize);
        btn.add_style_class_name('dock-apps-button');
        this._attachTooltip(btn, 'Aplicaciones');
        btn.connect('clicked', () => {
            this._closeStack();
            if (this._settings.get_boolean('custom-app-grid')) {
                if (this._appGridOverlay)
                    this._closeAppGrid();
                else
                    this._openAppGrid();
            } else if (Main.overview.visible && Main.overview.dash?.showAppsButton?.checked) {
                Main.overview.hide();
            } else {
                Main.overview.showApps();
            }
        });
        // Clic derecho → menú con opción de configuración
        btn.connect('button-press-event', (_actor, event) => {
            if (event.get_button() === Clutter.BUTTON_SECONDARY) {
                this._showAppsButtonMenu(btn);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        return btn;
    }

    _menuSide() {
        const pos = this._settings.get_string('position');
        if (pos === 'left')
            return St.Side.LEFT;
        if (pos === 'right')
            return St.Side.RIGHT;
        return St.Side.BOTTOM;
    }

    _deferred(fn) {
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            fn();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Abre un menú contextual con entradas [{label, callback} | {separator:true}]
    _openMenu(sourceActor, entries) {
        this._closeStack();
        if (this._itemMenu) {
            this._itemMenu.destroy();
            this._itemMenu = null;
        }
        if (!this._menuManager)
            this._menuManager = new PopupMenu.PopupMenuManager(this._dock);

        const menu = new PopupMenu.PopupMenu(sourceActor, 0.5, this._menuSide());
        for (const e of entries) {
            if (e.separator) {
                menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                continue;
            }
            const item = new PopupMenu.PopupMenuItem(e.label);
            item.connect('activate', () => e.callback());
            menu.addMenuItem(item);
        }

        Main.layoutManager.uiGroup.add_child(menu.actor);
        menu.actor.hide();
        this._menuManager.addMenu(menu);
        this._itemMenu = menu;

        menu.connect('open-state-changed', (m, isOpen) => {
            if (!isOpen) {
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    if (this._itemMenu === m)
                        this._itemMenu = null;
                    m.destroy();
                    return GLib.SOURCE_REMOVE;
                });
            }
        });

        menu.open();
    }

    // Conecta clic derecho a un actor; buildEntries() se evalúa al abrir
    _attachContextMenu(btn, buildEntries) {
        btn.connect('button-press-event', (_a, event) => {
            if (event.get_button() === Clutter.BUTTON_SECONDARY) {
                this._openMenu(btn, buildEntries());
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _quitApp(app) {
        try {
            app.request_quit();
        } catch (_e) {
            for (const w of app.get_windows())
                w.delete(global.get_current_time());
        }
    }

    _removeStack(stackId) {
        const stacks = safeParseStacks(this._settings.get_string('stacks'))
            .filter(s => s.id !== stackId);
        this._settings.set_string('stacks', JSON.stringify(stacks));
    }

    // ----------------------------------------------- miniaturas de ventanas
    _attachWindowPreview(btn, app) {
        btn.connect('enter-event', () => {
            if (this._dragActive)
                return Clutter.EVENT_PROPAGATE;
            this._cancelPreviewTimers();
            this._previewTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
                this._previewTimeout = 0;
                this._showPreview(btn, app);
                return GLib.SOURCE_REMOVE;
            });
            return Clutter.EVENT_PROPAGATE;
        });
        btn.connect('leave-event', () => {
            if (this._previewTimeout) {
                GLib.source_remove(this._previewTimeout);
                this._previewTimeout = 0;
            }
            this._schedulePreviewHide();
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _cancelPreviewTimers() {
        if (this._previewTimeout) {
            GLib.source_remove(this._previewTimeout);
            this._previewTimeout = 0;
        }
        if (this._previewHideTimeout) {
            GLib.source_remove(this._previewHideTimeout);
            this._previewHideTimeout = 0;
        }
    }

    _schedulePreviewHide() {
        if (this._previewHideTimeout)
            GLib.source_remove(this._previewHideTimeout);
        this._previewHideTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 220, () => {
            this._previewHideTimeout = 0;
            this._destroyPreview();
            return GLib.SOURCE_REMOVE;
        });
    }

    _destroyPreview() {
        if (this._previewPopup) {
            try {
                this._previewPopup.destroy();
            } catch (_e) { /* ya destruido */ }
            this._previewPopup = null;
        }
        this._previewApp = null;
    }

    // ------------------------------------------------------ tooltips (nombre)
    _attachTooltip(btn, text) {
        if (!text)
            return;
        btn.connect('enter-event', () => {
            if (this._dragActive)
                return Clutter.EVENT_PROPAGATE;
            this._cancelTooltip();
            this._tooltipTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                this._tooltipTimeout = 0;
                this._showTooltip(btn, text);
                return GLib.SOURCE_REMOVE;
            });
            return Clutter.EVENT_PROPAGATE;
        });
        btn.connect('leave-event', () => {
            this._hideTooltip();
            return Clutter.EVENT_PROPAGATE;
        });
        btn.connect('clicked', () => this._hideTooltip());
    }

    _cancelTooltip() {
        if (this._tooltipTimeout) {
            GLib.source_remove(this._tooltipTimeout);
            this._tooltipTimeout = 0;
        }
    }

    _hideTooltip() {
        this._cancelTooltip();
        if (this._tooltip) {
            try {
                this._tooltip.destroy();
            } catch (_e) { /* ya destruido */ }
            this._tooltip = null;
        }
    }

    _showTooltip(btn, text) {
        if (!btn || !btn.get_stage())
            return; // el botón ya no existe
        if (this._previewPopup)
            return; // si ya hay miniaturas, no mostramos el tooltip
        this._hideTooltip();
        const tip = new St.Label({style_class: 'dock-tooltip', text});
        Main.layoutManager.uiGroup.add_child(tip);

        const [bx, by] = btn.get_transformed_position();
        const bw = btn.width;
        const bh = btn.height;
        const [, natW] = tip.get_preferred_width(-1);
        const [, natH] = tip.get_preferred_height(natW);
        const monitor = Main.layoutManager.primaryMonitor;
        const pos = this._settings.get_string('position');
        let px, py;
        if (pos === 'left') {
            px = bx + bw + 8;
            py = by + bh / 2 - natH / 2;
        } else if (pos === 'right') {
            px = bx - natW - 8;
            py = by + bh / 2 - natH / 2;
        } else {
            px = bx + bw / 2 - natW / 2;
            py = by - natH - 8;
        }
        px = Math.max(monitor.x + 4, Math.min(px, monitor.x + monitor.width - natW - 4));
        py = Math.max(monitor.y + 4, Math.min(py, monitor.y + monitor.height - natH - 4));
        tip.set_position(Math.round(px), Math.round(py));

        tip.opacity = 0;
        tip.ease({opacity: 255, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._tooltip = tip;
    }

    _makeThumb(metaWindow, maxW, maxH) {
        const actor = metaWindow.get_compositor_private();
        if (!actor)
            return null;
        const [tw, th] = actor.get_size();
        if (tw <= 0 || th <= 0)
            return null;
        const scale = Math.min(maxW / tw, maxH / th, 1);
        return new Clutter.Clone({
            source: actor,
            width: Math.round(tw * scale),
            height: Math.round(th * scale),
            reactive: false,
        });
    }

    _showPreview(btn, app) {
        if (!btn || !btn.get_stage())
            return; // el botón ya no existe
        if (this._previewApp === app && this._previewPopup)
            return;
        const windows = app.get_windows();
        if (windows.length === 0)
            return;
        this._hideTooltip();
        this._destroyPreview();

        const popup = new St.BoxLayout({style_class: 'dock-preview', reactive: true});
        for (const w of windows) {
            const item = new St.Button({style_class: 'dock-preview-item', can_focus: true});
            const vbox = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                x_align: Clutter.ActorAlign.CENTER,
            });
            const thumb = this._makeThumb(w, 220, 140);
            if (thumb) {
                const frame = new St.Bin({style_class: 'dock-preview-thumb', child: thumb});
                vbox.add_child(frame);
            }
            const title = new St.Label({
                style_class: 'dock-preview-title',
                text: w.get_title() || app.get_name(),
            });
            title.clutter_text.set_ellipsize(3 /* END */);
            vbox.add_child(title);
            item.set_child(vbox);
            item.connect('clicked', () => {
                this._destroyPreview();
                if (Main.overview.visible)
                    Main.overview.hide();
                Main.activateWindow(w);
            });
            popup.add_child(item);
        }

        popup.connect('enter-event', () => {
            this._cancelPreviewTimers();
            return Clutter.EVENT_PROPAGATE;
        });
        popup.connect('leave-event', () => {
            this._schedulePreviewHide();
            return Clutter.EVENT_PROPAGATE;
        });

        Main.layoutManager.uiGroup.add_child(popup);

        const [bx, by] = btn.get_transformed_position();
        const bw = btn.width;
        const [, natW] = popup.get_preferred_width(-1);
        const [, natH] = popup.get_preferred_height(natW);
        const monitor = Main.layoutManager.primaryMonitor;
        const pos = this._settings.get_string('position');
        let px, py;
        if (pos === 'left') {
            px = bx + bw + 10;
            py = by + btn.height / 2 - natH / 2;
        } else if (pos === 'right') {
            px = bx - natW - 10;
            py = by + btn.height / 2 - natH / 2;
        } else {
            px = bx + bw / 2 - natW / 2;
            py = by - natH - 10;
        }
        px = Math.max(monitor.x + 8, Math.min(px, monitor.x + monitor.width - natW - 8));
        py = Math.max(monitor.y + 8, Math.min(py, monitor.y + monitor.height - natH - 8));
        popup.set_position(Math.round(px), Math.round(py));

        popup.opacity = 0;
        popup.ease({opacity: 255, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD});

        this._previewPopup = popup;
        this._previewApp = app;
    }

    _showAppsButtonMenu(sourceActor) {
        this._openMenu(sourceActor, [
            {label: 'Configurar Dock Stack…', callback: () => this.openPreferences()},
            {label: 'Ver todas las aplicaciones', callback: () => this._showApplications()},
        ]);
    }

    _showApplications() {
        if (this._settings.get_boolean('custom-app-grid'))
            this._openAppGrid();
        else
            Main.overview.showApps();
    }

    // ¿La app pertenece a la categoría (por su campo Categories del .desktop)?
    _appInCategory(appInfo, catKey) {
        if (catKey === 'all')
            return true;
        if (catKey === 'favorites')
            return AppFavorites.getAppFavorites().getFavoriteMap()[appInfo.get_id()] != null;
        const tokens = DockStacksExtension.CATEGORY_MAP[catKey];
        if (!tokens)
            return true;
        let catStr = '';
        try {
            catStr = appInfo.get_categories?.() || '';
        } catch (_e) {
            catStr = '';
        }
        if (!catStr)
            return false;
        const list = catStr.split(';');
        return tokens.some(t => list.includes(t));
    }

    // -------------------------------------------- rejilla de apps propia
    _openAppGrid() {
        this._closeAppGrid();
        this._closeStack();
        this._hideTooltip();

        const monitor = Main.layoutManager.primaryMonitor;
        const overlay = new St.Widget({
            style_class: 'dock-appgrid-overlay',
            reactive: true,
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
        });
        overlay.connect('button-press-event', () => {
            if (this._appGridMenu) {
                this._closeAppGridMenu();
                return Clutter.EVENT_STOP;
            }
            this._closeAppGrid();
            return Clutter.EVENT_STOP;
        });
        overlay.connect('key-press-event', (_a, ev) => {
            if (ev.get_key_symbol() === Clutter.KEY_Escape) {
                if (this._appGridMenu)
                    this._closeAppGridMenu();
                else
                    this._closeAppGrid();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        Main.layoutManager.uiGroup.add_child(overlay);
        // Registrar ya el overlay para poder cerrarlo siempre (aunque algo falle)
        this._appGridOverlay = overlay;

        const ph = Math.min(monitor.height - 140, 820);
        const sidebarW = 265;
        const gap = 16;
        const CELL_STEP = 136;          // ancho real de cada celda (110 + relleno + separación)
        const FRAME_EXTRA = 28 + 18;    // relleno del marco + barra de desplazamiento

        // Nº de columnas que caben en el ancho disponible (acotado), y el ancho
        // del marco de apps se ajusta EXACTAMENTE a esas columnas (sin franja vacía).
        const availGrid = Math.min(monitor.width - 120, 1400) - sidebarW - gap;
        const columns = Math.max(3, Math.min(8,
            Math.floor((availGrid - FRAME_EXTRA) / CELL_STEP)));
        const gridAreaW = columns * CELL_STEP + FRAME_EXTRA;
        const pw = sidebarW + gap + gridAreaW;

        // Contenedor transparente que aloja los dos marcos separados
        const panel = new St.BoxLayout({
            style_class: 'dock-appgrid-container',
            orientation: Clutter.Orientation.HORIZONTAL,
            reactive: true,
        });
        panel.connect('button-press-event', () => Clutter.EVENT_STOP); // absorbe clics
        panel.set_size(pw, ph);
        // Centrado: misma distancia a izquierda y derecha
        panel.set_position(
            Math.round((monitor.width - pw) / 2),
            Math.round((monitor.height - ph) / 2));
        overlay.add_child(panel);

        // Marcos interiores: blanco (claro) u oscuro, según el selector; opacidad configurable
        const opacity = this._settings.get_int('appgrid-opacity') / 100;
        const theme = this._settings.get_string('appgrid-theme'); // 'light' = blanco, 'dark' = oscuro
        const baseRGB = theme === 'light' ? '255, 255, 255' : '28, 28, 30';
        const innerStyle = `background-color: rgba(${baseRGB}, ${opacity.toFixed(2)});`;
        panel.add_style_class_name(theme);

        // --- Marco de categorías (mismo alto que el de apps) ---
        const sidebar = new St.BoxLayout({
            style_class: 'dock-appgrid-sidebar',
            orientation: Clutter.Orientation.VERTICAL,
        });
        sidebar.set_size(sidebarW, ph);          // mismo largo que el marco de apps
        panel.add_child(sidebar);

        const sidebarInner = new St.BoxLayout({
            style_class: 'dock-appgrid-inner',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,                      // llena todo el alto del marco
        });
        sidebarInner.set_style(innerStyle);
        sidebar.add_child(sidebarInner);

        this._appGridCategory = 'favorites';
        this._catButtons = {};
        for (const cat of DockStacksExtension.CATEGORIES) {
            const catRow = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
            });
            catRow.set_style('spacing: 10px;');
            if (cat.icon) {
                let cicon;
                try {
                    cicon = Gio.icon_new_for_string(cat.icon);
                } catch (_e) {
                    cicon = null;
                }
                if (cicon)
                    catRow.add_child(new St.Icon({gicon: cicon, icon_size: 20, y_align: Clutter.ActorAlign.CENTER}));
            }
            const catLabel = new St.Label({
                text: cat.label,
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.CENTER,
            });
            catLabel.clutter_text.set_ellipsize(0 /* PANGO_ELLIPSIZE_NONE */);
            catRow.add_child(catLabel);
            const catBtn = new St.Button({
                style_class: 'dock-appgrid-cat',
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                child: catRow,
            });
            if (cat.key === this._appGridCategory)
                catBtn.add_style_class_name('selected');
            catBtn.connect('clicked', () => {
                this._appGridCategory = cat.key;
                for (const k in this._catButtons)
                    this._catButtons[k].remove_style_class_name('selected');
                catBtn.add_style_class_name('selected');
                this._populateAppGrid(this._appGridSearch ? this._appGridSearch.get_text() : '');
            });
            this._catButtons[cat.key] = catBtn;
            sidebarInner.add_child(catBtn);
        }

        // Espaciador que empuja el botón de configuración al fondo
        sidebarInner.add_child(new St.Widget({y_expand: true}));

        // Botón de configuración (abre las preferencias) con icono personalizado
        const cfgBtn = new St.Button({
            style_class: 'dock-appgrid-cat dock-appgrid-config',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });
        const cfgBox = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });
        cfgBox.set_style('spacing: 10px;'); // en GNOME 48 'spacing' va por CSS, no en el constructor
        let cfgGicon;
        try {
            cfgGicon = Gio.icon_new_for_string('/home/fabarcad/Imágenes/Icon/config_icon_132468.png');
        } catch (_e) {
            cfgGicon = new Gio.ThemedIcon({name: 'emblem-system-symbolic'});
        }
        cfgBox.add_child(new St.Icon({gicon: cfgGicon, icon_size: 22, y_align: Clutter.ActorAlign.CENTER}));
        const cfgLbl = new St.Label({
            text: 'Configuración',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        });
        cfgBox.add_child(cfgLbl);
        cfgBtn.set_child(cfgBox);
        cfgBtn.connect('clicked', () => {
            this._closeAppGrid();
            this.openPreferences();
        });
        sidebarInner.add_child(cfgBtn);

        // --- Marco de aplicaciones (exterior + interior translúcido) ---
        const right = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'dock-appgrid-apps',
        });
        right.set_size(gridAreaW, ph);   // tamaño fijo → forma constante
        panel.add_child(right);

        const rightInner = new St.BoxLayout({
            style_class: 'dock-appgrid-inner',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        rightInner.set_style(innerStyle);
        right.add_child(rightInner);

        // Fila superior: buscador (más corto) + botón de ordenar
        const topRow = new St.BoxLayout({
            style_class: 'dock-appgrid-toprow',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
        });
        rightInner.add_child(topRow);

        const search = new St.Entry({
            style_class: 'dock-appgrid-search',
            can_focus: true,
            x_expand: false,
        });
        search.set_hint_text('Buscar aplicaciones…');
        search.set_width(Math.round(Math.min(520, (gridAreaW - 60) * 0.6)));
        topRow.add_child(search);
        this._appGridSearch = search;

        // Botón de orden alfabético (recuerda la elección entre aperturas)
        this._appGridSortDesc = this._settings.get_boolean('appgrid-sort-desc');
        const sortBtn = new St.Button({
            style_class: 'dock-appgrid-sort',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const sortIcon = new St.Icon({
            icon_name: this._appGridSortDesc
                ? 'view-sort-descending-symbolic'
                : 'view-sort-ascending-symbolic',
            icon_size: 20,
        });
        sortBtn.set_child(sortIcon);
        sortBtn.connect('clicked', () => {
            this._appGridSortDesc = !this._appGridSortDesc;
            this._settings.set_boolean('appgrid-sort-desc', this._appGridSortDesc);
            sortIcon.icon_name = this._appGridSortDesc
                ? 'view-sort-descending-symbolic'
                : 'view-sort-ascending-symbolic';
            this._populateAppGrid(this._appGridSearch ? this._appGridSearch.get_text() : '');
        });
        topRow.add_child(sortBtn);

        const scroll = new St.ScrollView({style_class: 'dock-appgrid-scroll', y_expand: true, x_expand: true});
        // Sin scroll horizontal (evita que se recorten columnas); vertical automático
        scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        const box = new St.BoxLayout({
            style_class: 'dock-appgrid-box',
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
        });
        scroll.set_child(box);
        rightInner.add_child(scroll);

        // Datos: todas las apps instaladas visibles
        this._allApps = Gio.AppInfo.get_all()
            .filter(a => a.should_show())
            .sort((a, b) => a.get_display_name().localeCompare(b.get_display_name()));
        this._appGridBox = box;
        // El marco ya se dimensionó para exactamente estas columnas
        this._appGridColumns = columns;

        search.clutter_text.connect('text-changed',
            () => this._populateAppGrid(search.get_text()));
        search.clutter_text.connect('activate', () => this._launchFirstApp());
        // Escape cierra la rejilla (sin modal, el foco está en el buscador)
        search.clutter_text.connect('key-press-event', (_a, ev) => {
            if (ev.get_key_symbol() === Clutter.KEY_Escape) {
                this._closeAppGrid();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._populateAppGrid('');

        // Sin modal: así el dock sigue visible y utilizable con la rejilla abierta.
        // Elevamos el dock por encima del overlay para que no quede tapado.
        const dockParent = this._container ? this._container.get_parent() : null;
        if (dockParent && overlay.get_parent() === dockParent) {
            try {
                dockParent.set_child_above_sibling(this._container, overlay);
            } catch (_e) { /* si no comparten padre, se ignora */ }
        }
        search.grab_key_focus();

        overlay.opacity = 0;
        overlay.ease({opacity: 255, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    _populateAppGrid(query) {
        const box = this._appGridBox;
        if (!box)
            return;
        box.destroy_all_children();
        const q = (query || '').toLowerCase().trim();
        const cat = this._appGridCategory || 'all';
        const apps = this._allApps.filter(a =>
            this._appInCategory(a, cat) &&
            (!q || a.get_display_name().toLowerCase().includes(q)));
        // _allApps ya está en orden ascendente; si se pide descendente, invertir
        if (this._appGridSortDesc)
            apps.reverse();
        this._appGridFiltered = apps;

        const cols = this._appGridColumns;
        let row = null;
        apps.forEach((app, i) => {
            if (i % cols === 0) {
                row = new St.BoxLayout({style_class: 'dock-appgrid-row'});
                box.add_child(row);
            }
            const cell = new St.Button({style_class: 'dock-appgrid-cell', can_focus: true});
            const vb = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                x_align: Clutter.ActorAlign.CENTER,
            });
            const gicon = app.get_icon() ?? new Gio.ThemedIcon({name: 'application-x-executable'});
            vb.add_child(new St.Icon({gicon, icon_size: 64}));
            const lbl = new St.Label({style_class: 'dock-appgrid-label', text: app.get_display_name()});
            lbl.clutter_text.set_line_wrap(true);
            lbl.clutter_text.set_ellipsize(3 /* END */);
            vb.add_child(lbl);
            cell.set_child(vb);
            cell.connect('clicked', () => this._launchAppInfo(app));
            cell.connect('button-press-event', (_a, ev) => {
                if (ev.get_button() === Clutter.BUTTON_SECONDARY) {
                    const [sx, sy] = ev.get_coords();
                    this._showAppGridMenu(app, sx, sy);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
            row.add_child(cell);
        });

        if (apps.length === 0) {
            const empty = new St.Label({
                style_class: 'dock-appgrid-label',
                text: 'Sin resultados',
            });
            box.add_child(empty);
        }
    }

    _launchFirstApp() {
        if (this._appGridFiltered && this._appGridFiltered.length > 0)
            this._launchAppInfo(this._appGridFiltered[0]);
    }

    _launchAppInfo(appInfo) {
        this._closeAppGrid();
        if (Main.overview.visible)
            Main.overview.hide();
        try {
            const ctx = global.create_app_launch_context(0, -1);
            appInfo.launch([], ctx);
        } catch (e) {
            logError(e, 'Dock Stack: no se pudo lanzar la aplicación');
        }
    }

    _showAppGridMenu(appInfo, stageX, stageY) {
        this._closeAppGridMenu();
        if (!this._appGridOverlay)
            return;
        const monitor = Main.layoutManager.primaryMonitor;

        const menu = new St.BoxLayout({
            style_class: 'dock-appgrid-menu',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
        });
        menu.connect('button-press-event', () => Clutter.EVENT_STOP); // absorbe

        const favs = AppFavorites.getAppFavorites();
        const isFav = favs.getFavoriteMap()[appInfo.get_id()] != null;

        const entries = [
            {label: 'Lanzar', cb: () => this._launchAppInfo(appInfo)},
        ];
        if (isFav) {
            entries.push({label: 'Quitar de favoritos', cb: () => {
                this._deferred(() => favs.removeFavorite(appInfo.get_id()));
                this._closeAppGridMenu();
            }});
        } else {
            entries.push({label: 'Anclar a favoritos', cb: () => {
                this._deferred(() => favs.addFavorite(appInfo.get_id()));
                this._closeAppGridMenu();
            }});
        }

        for (const e of entries) {
            const item = new St.Button({style_class: 'dock-appgrid-menu-item', x_expand: true});
            item.set_child(new St.Label({text: e.label, x_align: Clutter.ActorAlign.START}));
            item.connect('clicked', () => e.cb());
            menu.add_child(item);
        }

        this._appGridOverlay.add_child(menu);

        // Posición relativa al overlay (situado en el origen del monitor)
        let mx = stageX - monitor.x;
        let my = stageY - monitor.y;
        const [, mw] = menu.get_preferred_width(-1);
        const [, mh] = menu.get_preferred_height(mw);
        mx = Math.max(4, Math.min(mx, monitor.width - mw - 4));
        my = Math.max(4, Math.min(my, monitor.height - mh - 4));
        menu.set_position(Math.round(mx), Math.round(my));

        menu.opacity = 0;
        menu.ease({opacity: 255, duration: 100, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._appGridMenu = menu;
    }

    _closeAppGridMenu() {
        if (this._appGridMenu) {
            this._appGridMenu.destroy();
            this._appGridMenu = null;
        }
    }

    _closeAppGrid() {
        this._closeAppGridMenu();
        if (this._appGridOverlay) {
            this._appGridOverlay.destroy();
            this._appGridOverlay = null;
        }
        this._appGridBox = null;
        this._appGridFiltered = null;
        this._appGridSearch = null;
        this._catButtons = null;
    }

    // -------------------------------------------------- arrastrar para reordenar
    _makeReorderable(btn, group, index, meta) {
        btn._delegate = Object.assign({reorderGroup: group, reorderIndex: index, btn}, meta);
        const draggable = DND.makeDraggable(btn, {dragActorOpacity: 200});
        draggable.connect('drag-begin', () => {
            this._dragActive = true;
            btn.add_style_class_name('dragging');
            this._beginLiveReorder(btn);
        });
        const onEnd = () => {
            btn.remove_style_class_name('dragging');
            this._finishDrag();
        };
        draggable.connect('drag-end', onEnd);
        draggable.connect('drag-cancelled', onEnd);
        btn._draggable = draggable;
    }

    // Limpieza de fin de arrastre. Debe poder llamarse desde acceptDrop además
    // de desde 'drag-end'/'drag-cancelled', porque en un drop con ÉXITO GNOME
    // destruye el actor arrastrado y eso desconecta los handlers del draggable
    // ANTES de emitir 'drag-end' (dnd.js: disconnectAll en el destroy del
    // actor). Si solo confiáramos en 'drag-end', _dragActive quedaría en true
    // para siempre y bloquearía tooltips, miniaturas y reconstrucciones.
    _finishDrag() {
        this._dragActive = false;
        this._endLiveReorder();
        if (this._pendingRebuild) {
            this._pendingRebuild = false;
            this._queueRebuild();
        }
    }

    // Objetivo de "drop": el dock (this._dock._delegate = this)
    handleDragOver(source, _actor, x, y, _time) {
        if (!source || source.reorderGroup === undefined)
            return DND.DragMotionResult.NO_DROP;
        if (this._reorderCtx) {
            this._ensureReorderCtxReady(source);
            const idx = this._computeGroupDropIndex(source, x, y);
            this._applyLiveReorder(idx);
        }
        return DND.DragMotionResult.MOVE_DROP;
    }

    // ---- animación fluida: los iconos se apartan para abrir el hueco ----
    // NOTA: DND usa el propio botón como actor arrastrado y lo SACA del dock,
    // moviéndolo con el puntero. Por eso NUNCA trasladamos el actor fuente
    // (se sumaría a la posición del puntero) y capturamos la geometría de los
    // iconos restantes de forma perezosa, cuando el dock ya se ha reajustado.
    _beginLiveReorder(sourceActor) {
        this._reorderCtx = {
            source: sourceActor,
            group: sourceActor._delegate ? sourceActor._delegate.reorderGroup : undefined,
            vertical: this._isVertical(),
            prop: this._isVertical() ? 'translation_y' : 'translation_x',
            ready: false,
            actors: [],
            step: 0,
            lastDrop: -1,
        };
    }

    // Captura los iconos restantes (sin la fuente) y el "paso" de un hueco.
    _ensureReorderCtxReady(source) {
        const ctx = this._reorderCtx;
        if (!ctx || ctx.ready)
            return;
        const vertical = ctx.vertical;
        const actors = this._dock.get_children().filter(
            c => c !== ctx.source && c._delegate &&
                 c._delegate.reorderGroup === source.reorderGroup);
        if (actors.length === 0)
            return; // aún no reajustado; reintentar en el próximo movimiento
        const homes = actors.map(a => {
            const b = a.get_allocation_box();
            return vertical ? b.y1 : b.x1;
        });
        let step;
        if (actors.length >= 2) {
            step = homes[1] - homes[0];
        } else {
            const b = actors[0].get_allocation_box();
            step = (vertical ? (b.y2 - b.y1) : (b.x2 - b.x1)) + 4;
        }
        ctx.actors = actors;
        ctx.step = step;
        ctx.ready = true;
    }

    _applyLiveReorder(dropIndex) {
        const ctx = this._reorderCtx;
        if (!ctx || !ctx.ready)
            return;
        const m = ctx.actors.length;
        const d = Math.max(0, Math.min(dropIndex, m));
        if (d === ctx.lastDrop)
            return;
        ctx.lastDrop = d;
        // Los iconos con índice >= d se desplazan un "paso" para abrir el hueco.
        for (let j = 0; j < m; j++) {
            const actor = ctx.actors[j];
            if (!actor.get_stage())
                continue;
            actor.ease({
                [ctx.prop]: j >= d ? ctx.step : 0,
                duration: 180,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        }
    }

    _endLiveReorder() {
        const ctx = this._reorderCtx;
        this._reorderCtx = null;
        if (!ctx)
            return;
        for (const a of ctx.actors) {
            if (!a.get_stage())
                continue;
            a.ease({
                [ctx.prop]: 0,
                duration: 140,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        }
    }

    acceptDrop(source, _actor, x, y, _time) {
        if (!source || source.reorderGroup === undefined)
            return false;
        const newIndex = this._computeGroupDropIndex(source, x, y);
        const changed = this._performReorder(source, newIndex);
        // En un drop con éxito, 'drag-end' no llegará (el actor se destruye y
        // se desconectan los handlers), así que limpiamos el estado aquí.
        this._finishDrag();
        // DND saca el actor original del dock al arrastrarlo. Si NO cambia el
        // orden (misma posición), no hay ajuste de settings que reconstruya el
        // dock, así que el icono "desaparecería": forzamos la reconstrucción.
        if (!changed)
            this._deferred(() => this._rebuildItems());
        return true;
    }

    // Índice de inserción entre los iconos del grupo (la fuente ya no está en
    // el dock: DND la sacó). Devuelve 0..m (m = nº de iconos restantes).
    _computeGroupDropIndex(source, x, y) {
        const vertical = this._isVertical();
        const coord = vertical ? y : x;
        const sameGroup = this._dock.get_children()
            .filter(c => c._delegate && c._delegate.reorderGroup === source.reorderGroup);
        let newIndex = sameGroup.length;
        for (let i = 0; i < sameGroup.length; i++) {
            const box = sameGroup[i].get_allocation_box();
            const center = vertical ? (box.y1 + box.y2) / 2 : (box.x1 + box.x2) / 2;
            if (coord < center) {
                newIndex = i;
                break;
            }
        }
        return newIndex;
    }

    // Devuelve true si el orden cambió (y por tanto habrá reconstrucción).
    _performReorder(source, newIndex) {
        if (source.reorderGroup !== 'pinned')
            return false;
        const order = (this._pinnedTokens || []).slice();
        const from = order.indexOf(source.token);
        if (from < 0)
            return false;
        // newIndex ya está en el espacio SIN la fuente (0..order.length-1 tras
        // quitarla), por eso no hay que ajustar índices.
        const rest = order.slice();
        rest.splice(from, 1);
        const insert = Math.max(0, Math.min(newIndex, rest.length));
        rest.splice(insert, 0, source.token);
        if (JSON.stringify(rest) === JSON.stringify(order))
            return false; // sin cambios reales
        // Diferir la escritura para no mutar durante el propio drop
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._settings.set_string('dock-order', JSON.stringify(rest));
            return GLib.SOURCE_REMOVE;
        });
        return true;
    }

    // Construye la lista unificada de elementos anclados (favoritos + stacks),
    // respetando el orden guardado en 'dock-order' y añadiendo al final los
    // elementos nuevos que aún no estén en ese orden.
    _computePinnedEntries() {
        const favApps = new Map(); // appId -> Shell.App
        if (this._settings.get_boolean('show-favorites')) {
            const favs = AppFavorites.getAppFavorites().getFavoriteMap();
            for (const id in favs)
                favApps.set(favs[id].get_id(), favs[id]);
        }
        const stacks = safeParseStacks(this._settings.get_string('stacks'));
        const stackById = new Map(stacks.map(s => [s.id, s]));

        let saved = [];
        try {
            const parsed = JSON.parse(this._settings.get_string('dock-order'));
            if (Array.isArray(parsed))
                saved = parsed;
        } catch (_e) { /* orden vacío */ }

        const entries = [];
        const usedFav = new Set();
        const usedStack = new Set();
        for (const tok of saved) {
            if (typeof tok !== 'string')
                continue;
            if (tok.startsWith('fav:')) {
                const appId = tok.slice(4);
                if (favApps.has(appId) && !usedFav.has(appId)) {
                    entries.push({kind: 'fav', token: tok, app: favApps.get(appId)});
                    usedFav.add(appId);
                }
            } else if (tok.startsWith('stack:')) {
                const sid = tok.slice(6);
                if (stackById.has(sid) && !usedStack.has(sid)) {
                    entries.push({kind: 'stack', token: tok, stack: stackById.get(sid)});
                    usedStack.add(sid);
                }
            }
        }
        // Favoritos nuevos (en su orden natural) aún no incluidos
        for (const [appId, app] of favApps) {
            if (!usedFav.has(appId))
                entries.push({kind: 'fav', token: `fav:${appId}`, app});
        }
        // Stacks nuevos aún no incluidos
        for (const s of stacks) {
            if (!usedStack.has(s.id))
                entries.push({kind: 'stack', token: `stack:${s.id}`, stack: s});
        }
        return entries;
    }

    _stackIcon(stack, size) {
        let gicon;
        if (stack.icon) {
            gicon = Gio.icon_new_for_string(stack.icon);
        } else if (stack.type === 'folder' && stack.path) {
            // Icono según primeros elementos (aprox macOS): usamos icono de carpeta
            gicon = new Gio.ThemedIcon({name: 'folder-symbolic'});
            try {
                const f = Gio.File.new_for_path(stack.path);
                const info = f.query_info('standard::icon', Gio.FileQueryInfoFlags.NONE, null);
                gicon = info.get_icon();
            } catch (_e) { /* fallback */ }
        } else {
            gicon = new Gio.ThemedIcon({name: 'view-grid-symbolic'});
        }
        return new St.Icon({gicon, icon_size: size});
    }

    // ----------------------------------------------------------- stacks
    _toggleStack(stack, sourceBtn) {
        if (this._stackOverlay && this._currentStackId === stack.id) {
            this._closeStack();
            return;
        }
        this._closeStack();
        this._closeAppGrid();
        if (Main.overview.visible)
            Main.overview.hide();
        this._currentStackId = stack.id;

        const entries = this._collectEntries(stack);
        const iconSize = Math.max(32, this._settings.get_int('icon-size'));
        const style = stack.style || this._settings.get_string('stack-style');

        // Raíz modal a pantalla completa
        const overlay = new St.Widget({
            reactive: true,
            x: 0, y: 0,
            width: global.stage.width,
            height: global.stage.height,
        });
        // Fondo transparente: clic fuera => cerrar
        const bg = new St.Widget({
            reactive: true,
            x: 0, y: 0,
            width: global.stage.width,
            height: global.stage.height,
        });
        bg.connect('button-press-event', () => {
            this._closeStack();
            return Clutter.EVENT_STOP;
        });
        overlay.add_child(bg);
        overlay.connect('key-press-event', (_a, ev) => {
            if (ev.get_key_symbol() === Clutter.KEY_Escape)
                this._closeStack();
            return Clutter.EVENT_STOP;
        });
        Main.layoutManager.uiGroup.add_child(overlay);

        this._stackOverlay = overlay;
        this._stackGrab = Main.pushModal(overlay, {actionMode: Shell.ActionMode.POPUP});
        overlay.grab_key_focus();

        const onActivate = (entry) => {
            this._activateEntry(entry);
            this._closeStack();
        };

        if (style === 'fan')
            this._buildFan(overlay, stack, entries, sourceBtn, iconSize, onActivate);
        else
            this._buildGrid(overlay, stack, entries, sourceBtn, iconSize, onActivate);
    }

    _buildGrid(overlay, stack, entries, sourceBtn, iconSize, onActivate) {
        const columns = Math.min(
            this._settings.get_int('stack-columns'),
            Math.max(1, entries.length));
        const popup = new StackPopup(stack.name);
        popup.setEntries(entries, columns, iconSize, onActivate);
        overlay.add_child(popup);

        const [bx, by] = sourceBtn.get_transformed_position();
        const bw = sourceBtn.width;
        const [, natW] = popup.get_preferred_width(-1);
        const [, natH] = popup.get_preferred_height(natW);
        const monitor = Main.layoutManager.primaryMonitor;
        let px = bx + bw / 2 - natW / 2;
        px = Math.max(monitor.x + 8, Math.min(px, monitor.x + monitor.width - natW - 8));
        let py = by - natH - 8;
        if (py < monitor.y + 8)
            py = by + sourceBtn.height + 8;
        popup.set_position(Math.round(px), Math.round(py));

        // Aparición rápida (casi instantánea) del contenedor
        popup.set_pivot_point(0.5, 1.0);
        popup.scale_y = 0.9;
        popup.translation_y = 12;
        popup.opacity = 0;
        popup.ease({
            scale_y: 1,
            translation_y: 0,
            opacity: 255,
            duration: 110,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _buildFan(overlay, stack, entries, sourceBtn, iconSize, onActivate) {
        const monitor = Main.layoutManager.primaryMonitor;
        const [bx, by] = sourceBtn.get_transformed_position();
        const bw = sourceBtn.width;
        const centerX = bx + bw / 2;

        const MAX_FAN = 14;
        const ordered = entries.slice(0, MAX_FAN);
        // Cabecera "Abrir carpeta" en la cima (solo stacks de carpeta)
        if (stack.type === 'folder' && stack.path) {
            ordered.push({
                name: 'Abrir carpeta',
                gicon: new Gio.ThemedIcon({name: 'folder-open-symbolic'}),
                kind: 'open-folder',
                uri: Gio.File.new_for_path(stack.path).get_uri(),
            });
        }

        const goingUp = this._settings.get_string('position') !== 'top';
        const step = iconSize + 18;   // separación vertical entre elementos
        const curve = this._settings.get_int('fan-curve'); // curvatura de la tira
        const startY = by - 6;        // justo encima del dock
        const n = ordered.length;
        // Desplazamiento horizontal del arco para el elemento i (0 abajo → n-1 arriba)
        const curveX = (i) => {
            const t = n > 1 ? i / (n - 1) : 0;
            return curve * Math.sin(t * Math.PI / 2);
        };

        ordered.forEach((entry, i) => {
            const cell = this._makeFanCell(entry, iconSize, () => {
                if (entry.kind === 'open-folder') {
                    if (Main.overview.visible)
                        Main.overview.hide();
                    try {
                        Gio.AppInfo.launch_default_for_uri(entry.uri, null);
                    } catch (e) {
                        logError(e, 'Dock Stack: no se pudo abrir la carpeta');
                    }
                    this._closeStack();
                } else {
                    onActivate(entry);
                }
            });
            overlay.add_child(cell);

            const [, cw] = cell.get_preferred_width(-1);
            const [, ch] = cell.get_preferred_height(cw);

            // Tira semi-curva estilo macOS: la COLUMNA DE ICONOS sigue el arco.
            // El icono es el último hijo de la celda, así que anclamos por el
            // borde derecho para que todos los iconos queden alineados y las
            // etiquetas (de distinto ancho) crezcan hacia la izquierda.
            const RPAD = 6;                 // padding derecho de la celda (CSS)
            const iconAnchorX = centerX + curveX(i);
            let tx = iconAnchorX - cw + RPAD + iconSize / 2;
            let ty = goingUp ? startY - (i + 1) * step : startY + (i + 1) * step;
            tx = Math.max(monitor.x + 8, Math.min(tx, monitor.x + monitor.width - cw - 8));
            ty = Math.max(monitor.y + 8, Math.min(ty, monitor.y + monitor.height - ch - 8));

            // Estado inicial: todos apilados sobre el icono del dock (colapsados)
            const startX = centerX - cw + RPAD + iconSize / 2;
            cell.set_position(Math.round(startX), Math.round(startY - ch));
            cell.opacity = 0;
            cell.set_pivot_point(0.5, 1.0);
            cell.scale_x = 0.4;
            cell.scale_y = 0.4;

            // Despliegue en abanico rápido (casi instantáneo)
            cell.ease({
                x: Math.round(tx),
                y: Math.round(ty),
                opacity: 255,
                scale_x: 1,
                scale_y: 1,
                duration: 140,
                delay: i * 10,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        });
    }

    _makeFanCell(entry, iconSize, onClick) {
        const cell = new St.Button({style_class: 'dock-fan-cell', can_focus: true});
        // El marco (pastilla) envuelve el nombre Y el icono juntos
        const frame = new St.BoxLayout({
            style_class: 'dock-fan-frame',
            orientation: Clutter.Orientation.HORIZONTAL,
        });
        const lbl = new St.Label({
            style_class: 'dock-fan-label',
            text: entry.name,
            y_align: Clutter.ActorAlign.CENTER,
        });
        lbl.clutter_text.set_ellipsize(3 /* END */);
        frame.add_child(lbl);
        frame.add_child(new St.Icon({gicon: entry.gicon, icon_size: iconSize}));
        cell.set_child(frame);
        cell.connect('clicked', onClick);
        return cell;
    }

    _collectEntries(stack) {
        const entries = [];
        if (stack.type === 'apps') {
            const sys = APP_SYSTEM();
            for (const desktopId of (stack.apps || [])) {
                const app = sys.lookup_app(desktopId);
                if (!app)
                    continue;
                entries.push({
                    name: app.get_name(),
                    gicon: app.get_app_info()?.get_icon() ??
                        new Gio.ThemedIcon({name: 'application-x-executable'}),
                    kind: 'app',
                    app,
                });
            }
        } else if (stack.type === 'folder' && stack.path) {
            const max = this._settings.get_int('stack-max-items');
            try {
                const dir = Gio.File.new_for_path(stack.path);
                const en = dir.enumerate_children(
                    'standard::name,standard::display-name,standard::icon,standard::is-hidden,standard::type',
                    Gio.FileQueryInfoFlags.NONE, null);
                let info;
                const list = [];
                while ((info = en.next_file(null)) !== null) {
                    if (info.get_is_hidden())
                        continue;
                    list.push(info);
                }
                en.close(null);
                list.sort((a, b) =>
                    a.get_display_name().localeCompare(b.get_display_name()));
                for (const inf of list.slice(0, max)) {
                    const child = dir.get_child(inf.get_name());
                    entries.push({
                        name: inf.get_display_name(),
                        gicon: inf.get_icon() ??
                            new Gio.ThemedIcon({name: 'text-x-generic'}),
                        kind: 'file',
                        uri: child.get_uri(),
                    });
                }
            } catch (e) {
                logError(e, 'Dock Stacks: no se pudo leer la carpeta');
            }
        }
        // Ordenar por nombre según la configuración (ascendente / descendente)
        entries.sort((a, b) => a.name.localeCompare(b.name));
        if (this._settings.get_string('stack-sort') === 'desc')
            entries.reverse();
        return entries;
    }

    _activateEntry(entry) {
        if (Main.overview.visible)
            Main.overview.hide();
        if (entry.kind === 'app') {
            entry.app.activate();
        } else if (entry.kind === 'file') {
            try {
                Gio.AppInfo.launch_default_for_uri(entry.uri, null);
            } catch (e) {
                logError(e, 'Dock Stacks: no se pudo abrir el archivo');
            }
        }
    }

    _closeStack() {
        if (this._stackGrab) {
            Main.popModal(this._stackGrab);
            this._stackGrab = null;
        }
        if (this._stackPopup) {
            this._stackPopup.destroy();
            this._stackPopup = null;
        }
        if (this._stackOverlay) {
            this._stackOverlay.destroy();
            this._stackOverlay = null;
        }
        this._currentStackId = null;
    }

    // ----------------------------------------------------------- style / layout
    _applyStyle() {
        if (!this._dock)
            return;
        this._dock.orientation = this._isVertical()
            ? Clutter.Orientation.VERTICAL
            : Clutter.Orientation.HORIZONTAL;
        const op = this._settings.get_int('background-opacity') / 100;
        // Opacidad vía inline style sobre el color de fondo
        this._dock.set_style(
            `background-color: rgba(30,30,30,${op.toFixed(2)});`);
        this._relayout();
    }

    // ------------------------------------------------ ocultado (auto/intelli)
    _applyAutohide() {
        const autohide = this._settings.get_boolean('autohide');
        const intellihide = this._settings.get_boolean('intellihide');
        const needEdge = autohide || intellihide;

        if (this._hotEdge) {
            Main.layoutManager.removeChrome(this._hotEdge);
            this._hotEdge.destroy();
            this._hotEdge = null;
        }

        if (needEdge) {
            // Borde caliente para revelar el dock oculto
            this._hotEdge = new St.Widget({reactive: true});
            Main.layoutManager.addChrome(this._hotEdge, {affectsStruts: false});
            this._hotEdge.connect('enter-event', () => {
                this._reveal();
                return Clutter.EVENT_PROPAGATE;
            });
        }

        this._relayout();
        this._updateVisibility();
    }

    // Revelar temporalmente (ratón en el borde o sobre el dock)
    _reveal() {
        this._revealed = true;
        this._cancelHideTimer();
        this._updateVisibility();
        this._scheduleUnreveal();
    }

    _cancelHideTimer() {
        if (this._hideTimeout) {
            GLib.source_remove(this._hideTimeout);
            this._hideTimeout = 0;
        }
    }

    _scheduleUnreveal() {
        this._cancelHideTimer();
        this._hideTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._hideTimeout = 0;
            this._revealed = false;
            this._updateVisibility();
            return GLib.SOURCE_REMOVE;
        });
    }

    _onHover(hovering) {
        const autohide = this._settings.get_boolean('autohide');
        const intellihide = this._settings.get_boolean('intellihide');
        if (!autohide && !intellihide)
            return;
        if (hovering) {
            this._revealed = true;
            this._cancelHideTimer();
            this._updateVisibility();
        } else {
            this._scheduleUnreveal();
        }
    }

    // Recalcula la visibilidad con un pequeño retardo, agrupando ráfagas de eventos
    _scheduleVisibility() {
        if (this._visTimeout)
            return;
        this._visTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 90, () => {
            this._visTimeout = 0;
            this._updateVisibility();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Reaplica la reserva de espacio (struts) re-registrando la chrome
    _applyReserveSpace() {
        if (!this._container)
            return;
        const reserve = this._settings.get_boolean('reserve-space');
        this._strutsActive = reserve;
        try {
            Main.layoutManager.removeChrome(this._container);
            Main.layoutManager.addChrome(this._container, {
                affectsStruts: reserve,
                trackFullscreen: true,
            });
        } catch (_e) { /* el chrome puede no estar añadido aún */ }
        this._relayout();
        this._updateVisibility();
    }

    // Decide si el dock debe verse
    _updateVisibility() {
        if (!this._container)
            return;
        // En pantalla completa o con una ventana MAXIMIZADA en el monitor
        // principal, ocultar el dock y LIBERAR el espacio reservado (juegos,
        // vídeo o apps maximizadas), por encima de "reservar espacio" /
        // intellihide / autohide.
        if (this._shouldHideForWindow()) {
            this._setStruts(false);
            this._showDock(false);
            return;
        }
        // Si se reserva espacio, el dock está siempre visible (no se oculta)
        if (this._settings.get_boolean('reserve-space')) {
            this._setStruts(true);
            this._showDock(true);
            return;
        }
        this._setStruts(false);
        const autohide = this._settings.get_boolean('autohide');
        const intellihide = this._settings.get_boolean('intellihide');

        let show;
        if (this._stackOverlay || this._revealed)
            show = true;
        else if (autohide)
            show = false;
        else if (intellihide)
            show = !this._windowOverlapsDock();
        else
            show = true;

        this._showDock(show);
    }

    _isMonitorInFullscreen() {
        try {
            const idx = Main.layoutManager.primaryIndex;
            return global.display.get_monitor_in_fullscreen(idx);
        } catch (_e) {
            return false;
        }
    }

    // ¿Debe ocultarse el dock por la ventana activa? Solo en PANTALLA COMPLETA
    // real (lo que hacen los juegos como WoW en modo "Pantalla completa"), o una
    // ventana sin bordes que cubre TODO el monitor. NO con ventanas meramente
    // maximizadas (el launcher de Battle.net, Firefox, etc.), que son
    // indistinguibles entre sí y deben conservar las barras.
    _shouldHideForWindow() {
        return this._isMonitorInFullscreen() ||
               this._hasFullMonitorWindow();
    }

    // Activa/desactiva el espacio reservado (struts) en caliente. Solo re-añade
    // el chrome cuando cambia el estado, para no provocar recolocaciones en
    // cadena. Al ocultar el dock por un juego/ventana maximizada liberamos el
    // espacio; al volver, se restaura si "reservar espacio" está activo.
    _setStruts(active) {
        if (!this._container)
            return;
        if (this._strutsActive === active)
            return;
        this._strutsActive = active;
        try {
            Main.layoutManager.removeChrome(this._container);
            Main.layoutManager.addChrome(this._container, {
                affectsStruts: active,
                trackFullscreen: true,
            });
            this._relayout();
        } catch (_e) { /* el chrome puede no estar añadido aún */ }
    }

    // Detecta juegos en "ventana sin bordes" (fake fullscreen): una ventana
    // NORMAL, no maximizada, cuyo marco cubre el monitor COMPLETO (incluida la
    // zona de la barra superior). Comparar con la geometría completa del
    // monitor —no con el área de trabajo— distingue este modo de una ventana
    // simplemente maximizada (que respeta la barra superior).
    _hasFullMonitorWindow() {
        try {
            const idx = Main.layoutManager.primaryIndex;
            const m = Main.layoutManager.primaryMonitor;
            if (!m)
                return false;
            const ws = global.workspace_manager.get_active_workspace();
            const windows = global.display.get_tab_list(Meta.TabList.NORMAL, ws);
            for (const w of windows) {
                if (!w || w.minimized)
                    continue;
                if (w.get_monitor() !== idx)
                    continue;
                if (w.get_window_type() !== Meta.WindowType.NORMAL)
                    continue;
                // Ignorar ventanas simplemente maximizadas.
                if (w.get_maximized &&
                    w.get_maximized() === (Meta.MaximizeFlags.HORIZONTAL | Meta.MaximizeFlags.VERTICAL))
                    continue;
                const r = w.get_frame_rect();
                if (r.x <= m.x && r.y <= m.y &&
                    r.x + r.width >= m.x + m.width &&
                    r.y + r.height >= m.y + m.height)
                    return true;
            }
        } catch (_e) { /* sin cambios */ }
        return false;
    }

    _windowOverlapsDock() {
        if (!this._dockHomeRect)
            return false;
        const monitorIndex = Main.layoutManager.primaryIndex;
        const ws = global.workspace_manager.get_active_workspace();
        if (!ws)
            return false;
        const d = this._dockHomeRect;
        for (const w of ws.list_windows()) {
            if (w.minimized)
                continue;
            if (w.get_monitor() !== monitorIndex)
                continue;
            const type = w.get_window_type();
            if (type !== Meta.WindowType.NORMAL && type !== Meta.WindowType.DIALOG &&
                type !== Meta.WindowType.MODAL_DIALOG)
                continue;
            const r = w.get_frame_rect();
            if (r.x < d.x + d.width && r.x + r.width > d.x &&
                r.y < d.y + d.height && r.y + r.height > d.y)
                return true;
        }
        return false;
    }

    _showDock(show) {
        if (!this._container)
            return;
        const c = this._container;
        if (this._dockShown === show) {
            // Auto-corrección: si el estado ya es el deseado pero la animación
            // quedó a medias (sin transición en curso), fijar el estado final.
            if (!c.get_transition('opacity')) {
                if (show) {
                    if (!c.visible || c.opacity !== 255 ||
                        c.translation_x !== 0 || c.translation_y !== 0) {
                        c.visible = true;
                        c.reactive = true;
                        c.translation_x = 0;
                        c.translation_y = 0;
                        c.opacity = 255;
                    }
                } else if (c.visible) {
                    c.visible = false;
                    c.opacity = 0;
                    c.translation_x = 0;
                    c.translation_y = 0;
                }
            }
            return;
        }
        this._dockShown = show;
        // Cancela cualquier animación pendiente (y su onComplete obsoleto)
        c.remove_all_transitions();
        c.reactive = show;

        // Desplazamiento de entrada/salida según la posición del dock
        const pos = this._settings.get_string('position');
        const w = (this._dockHomeRect ? this._dockHomeRect.width : this._container.width) || 80;
        const h = (this._dockHomeRect ? this._dockHomeRect.height : this._container.height) || 80;
        let offX = 0;
        let offY = 0;
        if (pos === 'left')
            offX = -(w + 16);
        else if (pos === 'right')
            offX = w + 16;
        else
            offY = h + 16; // inferior: se desliza desde abajo

        if (show) {
            this._container.visible = true;
            // Estado inicial: fuera de pantalla y transparente
            this._container.translation_x = offX;
            this._container.translation_y = offY;
            this._container.opacity = 0;
            // Aparición rápida y fluida deslizándose hasta su sitio
            this._container.ease({
                translation_x: 0,
                translation_y: 0,
                opacity: 255,
                duration: 200,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onComplete: () => {
                    // Fijar el estado final por si la animación se interrumpió
                    if (this._dockShown && this._container) {
                        this._container.translation_x = 0;
                        this._container.translation_y = 0;
                        this._container.opacity = 255;
                    }
                },
            });
        } else {
            this._container.ease({
                translation_x: offX,
                translation_y: offY,
                opacity: 0,
                duration: 160,
                mode: Clutter.AnimationMode.EASE_IN_CUBIC,
                onComplete: () => {
                    // Solo ocultar si sigue siendo el estado deseado
                    if (this._dockShown === false && this._container) {
                        this._container.visible = false;
                        this._container.translation_x = 0;
                        this._container.translation_y = 0;
                    }
                },
            });
        }
    }

    _relayout() {
        if (!this._container || !this._dock)
            return;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        const [, dockW] = this._container.get_preferred_width(-1);
        const [, dockH] = this._container.get_preferred_height(-1);
        // Con reserva de espacio, el dock debe TOCAR el borde para que Mutter
        // reserve el espacio (los struts solo cuentan si el actor llega al borde).
        const margin = this._settings.get_boolean('reserve-space') ? 0 : 6;
        const pos = this._settings.get_string('position');

        let x, y;
        if (pos === 'bottom') {
            x = monitor.x + Math.round((monitor.width - dockW) / 2);
            y = monitor.y + monitor.height - dockH - margin;
        } else if (pos === 'left') {
            x = monitor.x + margin;
            y = monitor.y + Math.round((monitor.height - dockH) / 2);
        } else { // right
            x = monitor.x + monitor.width - dockW - margin;
            y = monitor.y + Math.round((monitor.height - dockH) / 2);
        }
        this._container.set_position(x, y);
        // Rect "de casa" del dock (posición visible), usado para detectar solape
        this._dockHomeRect = {x, y, width: dockW, height: dockH};

        // Borde caliente pegado al borde de la pantalla
        if (this._hotEdge) {
            if (pos === 'bottom') {
                this._hotEdge.set_position(monitor.x, monitor.y + monitor.height - 2);
                this._hotEdge.set_size(monitor.width, 2);
            } else if (pos === 'left') {
                this._hotEdge.set_position(monitor.x, monitor.y);
                this._hotEdge.set_size(2, monitor.height);
            } else {
                this._hotEdge.set_position(monitor.x + monitor.width - 2, monitor.y);
                this._hotEdge.set_size(2, monitor.height);
            }
        }

        this._scheduleVisibility();
        this._scheduleIconGeometryUpdate();
    }

    // Hace que la animación de minimizar apunte al icono del dock
    _scheduleIconGeometryUpdate() {
        if (this._geomIdle)
            return;
        this._geomIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._geomIdle = 0;
            this._updateIconGeometries();
            return GLib.SOURCE_REMOVE;
        });
    }

    _updateIconGeometries() {
        // Solo cuando el dock está visible/mapeado (posiciones válidas).
        // Si está oculto, se conserva la última geometría (misma posición de casa).
        if (!this._container || !this._container.visible || !this._appButtonList)
            return;
        for (const {app, btn} of this._appButtonList) {
            try {
                if (!btn.get_stage())
                    continue; // botón ya destruido
                const wins = app.get_windows();
                if (wins.length === 0)
                    continue;
                const [x, y] = btn.get_transformed_position();
                const w = btn.width;
                const h = btn.height;
                if (!(w > 0 && h > 0) || Number.isNaN(x) || Number.isNaN(y))
                    continue;
                const rect = new Mtk.Rectangle({
                    x: Math.round(x),
                    y: Math.round(y),
                    width: Math.round(w),
                    height: Math.round(h),
                });
                for (const win of wins)
                    win.set_icon_geometry(rect);
            } catch (_e) { /* actor destruido u otro problema puntual */ }
        }
    }
}

// Categorías de la barra lateral de la rejilla de aplicaciones
DockStacksExtension.CATEGORIES = [
    {key: 'favorites', label: 'Favoritos', icon: '/home/fabarcad/Imágenes/Icon/favoritos.png'},
    {key: 'development', label: 'Desarrollo', icon: '/home/fabarcad/Imágenes/Icon/desarrollo.png'},
    {key: 'games', label: 'Juegos', icon: '/home/fabarcad/Imágenes/Icon/juego.png'},
    {key: 'internet', label: 'Internet', icon: '/home/fabarcad/Imágenes/Icon/Internet.png'},
    {key: 'multimedia', label: 'Multimedia', icon: '/home/fabarcad/Imágenes/Icon/media.png'},
    {key: 'office', label: 'Oficina', icon: '/home/fabarcad/Imágenes/Icon/office.png'},
    {key: 'system', label: 'Sistema', icon: '/home/fabarcad/Imágenes/Icon/sistema.png'},
    {key: 'utilities', label: 'Utilidades', icon: '/home/fabarcad/Imágenes/Icon/utilidades.png'},
    {key: 'all', label: 'Todas las aplicaciones', icon: '/home/fabarcad/Imágenes/Icon/todas aplicaciones.png'},
];

// Mapeo a las categorías estándar de freedesktop (campo Categories del .desktop)
DockStacksExtension.CATEGORY_MAP = {
    development: ['Development', 'IDE', 'Building', 'Debugger'],
    games: ['Game'],
    internet: ['Network', 'WebBrowser', 'Email', 'InstantMessaging', 'Chat'],
    multimedia: ['AudioVideo', 'Audio', 'Video', 'Player', 'Music', 'Graphics'],
    office: ['Office', 'WordProcessor', 'Spreadsheet', 'Presentation', 'Calendar'],
    system: ['System', 'Settings', 'Monitor', 'Security'],
    utilities: ['Utility', 'Accessibility', 'Archiving', 'FileManager', 'TerminalEmulator'],
};
