/* Dock Stacks — panel de preferencias (GTK4 / libadwaita) */

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {makeTranslator, LANGUAGE_CHOICES} from './translations.js';

// Traductor a nivel de módulo; se (re)configura en fillPreferencesWindow según
// la clave 'language'. Por defecto identidad (español) hasta que se configure.
let _ = (s) => s;

function uuidv4() {
    return GLib.uuid_string_random();
}

function readStacks(settings) {
    try {
        const v = JSON.parse(settings.get_string('stacks'));
        return Array.isArray(v) ? v : [];
    } catch (_e) {
        return [];
    }
}

function writeStacks(settings, stacks) {
    settings.set_string('stacks', JSON.stringify(stacks));
}

export default class DockStacksPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(720, 640);
        this._prefPages = [];

        const build = () => {
            _ = makeTranslator(settings);
            // Quitar las páginas previas (para reconstruir traducidas)
            for (const p of this._prefPages) {
                try { window.remove(p); } catch (_e) { /* ya quitada */ }
            }
            this._prefPages = [];
            this._buildGeneralPage(window, settings);
            this._buildStacksPage(window, settings);
            this._buildAboutPage(window);
        };
        build();

        // Al cambiar el idioma, reconstruir las páginas para traducir esta
        // ventana en vivo. Se difiere para no destruir el widget que emitió
        // el cambio durante su propia señal.
        const langId = settings.connect('changed::language', () => {
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                if (this._prefPages)
                    build();
                return GLib.SOURCE_REMOVE;
            });
        });
        window.connect('destroy', () => {
            this._prefPages = null;
            try { settings.disconnect(langId); } catch (_e) { /* ok */ }
        });
    }

    // ------------------------------------------------------------- Acerca De
    _buildAboutPage(window) {
        const page = new Adw.PreferencesPage({
            title: _('Acerca De'),
            icon_name: 'help-about-symbolic',
        });
        window.add(page);
        if (this._prefPages) this._prefPages.push(page);

        const group = new Adw.PreferencesGroup();
        page.add(group);

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 14,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
            margin_top: 24,
            margin_bottom: 24,
            margin_start: 12,
            margin_end: 12,
        });

        // Imagen
        const imgPath = '/home/fabarcad/Imágenes/Icon/abaza.jpg';
        if (GLib.file_test(imgPath, GLib.FileTest.EXISTS)) {
            const pic = Gtk.Picture.new_for_filename(imgPath);
            pic.set_can_shrink(true);
            pic.set_content_fit(Gtk.ContentFit.CONTAIN);
            pic.set_size_request(240, 300);
            pic.add_css_class('card');
            box.append(pic);
        }

        // Líneas de texto
        const l1 = new Gtk.Label({
            label: _('Aplicaciones y Utilitarios'),
            css_classes: ['title-2'],
        });
        box.append(l1);

        const l2 = new Gtk.Label({
            label: 'ABAZA',
            css_classes: ['title-1'],
        });
        box.append(l2);

        group.add(box);
    }

    // Reproduce un sonido de prueba (mismo criterio que la extensión)
    _playTestSound(path) {
        if (!path) {
            const disp = Gdk.Display.get_default();
            if (disp)
                disp.beep();
            return;
        }
        const candidates = [
            ['pw-play', [path]],
            ['paplay', [path]],
            ['ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', path]],
            ['mpv', ['--no-video', '--really-quiet', path]],
            ['gst-play-1.0', ['--no-interactive', path]],
            ['canberra-gtk-play', ['-f', path]],
        ];
        for (const [bin, args] of candidates) {
            const full = GLib.find_program_in_path(bin);
            if (!full)
                continue;
            try {
                Gio.Subprocess.new([full, ...args],
                    Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
                break;
            } catch (_e) { /* probar el siguiente */ }
        }
    }

    // ------------------------------------------------------------- General
    _buildGeneralPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);
        if (this._prefPages) this._prefPages.push(page);

        // Idioma
        const langGroup = new Adw.PreferencesGroup({title: _('Idioma')});
        page.add(langGroup);

        const langModel = new Gtk.StringList();
        const langCodes = [];
        for (const [code, label] of LANGUAGE_CHOICES) {
            // La opción "auto" se traduce; los nombres de idioma van en su idioma.
            langModel.append(code === 'auto' ? _('Automático (según el sistema)') : label);
            langCodes.push(code);
        }
        const langRow = new Adw.ComboRow({
            title: _('Idioma de la extensión'),
            subtitle: _('Cambia el idioma de los textos de la extensión (dock, menús y esta ventana). "Automático" sigue el idioma del sistema.'),
            model: langModel,
        });
        const curLang = settings.get_string('language');
        langRow.selected = Math.max(0, langCodes.indexOf(curLang));
        langRow.connect('notify::selected', () => {
            const code = langCodes[langRow.selected] || 'auto';
            if (settings.get_string('language') !== code)
                settings.set_string('language', code);
        });
        langGroup.add(langRow);

        const group = new Adw.PreferencesGroup({title: _('Apariencia del dock')});
        page.add(group);

        // Tamaño de icono
        const iconRow = new Adw.SpinRow({
            title: _('Tamaño de icono'),
            subtitle: _('Píxeles'),
            adjustment: new Gtk.Adjustment({lower: 24, upper: 128, step_increment: 2, value: settings.get_int('icon-size')}),
        });
        settings.bind('icon-size', iconRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(iconRow);

        // Posición
        const posModel = new Gtk.StringList();
        [_('Inferior'), _('Izquierda'), _('Derecha')].forEach(s => posModel.append(s));
        const posKeys = ['bottom', 'left', 'right'];
        const posRow = new Adw.ComboRow({
            title: _('Posición'),
            model: posModel,
            selected: Math.max(0, posKeys.indexOf(settings.get_string('position'))),
        });
        posRow.connect('notify::selected', () => {
            settings.set_string('position', posKeys[posRow.selected]);
        });
        group.add(posRow);

        // Opacidad
        const opRow = new Adw.SpinRow({
            title: _('Opacidad del fondo (%)'),
            adjustment: new Gtk.Adjustment({lower: 0, upper: 100, step_increment: 5, value: settings.get_int('background-opacity')}),
        });
        settings.bind('background-opacity', opRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(opRow);

        // Autohide
        const autoRow = new Adw.SwitchRow({
            title: _('Ocultar siempre (autohide)'),
            subtitle: _('El dock queda oculto y se revela al llevar el ratón al borde'),
        });
        settings.bind('autohide', autoRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(autoRow);

        // Intellihide
        const intelliRow = new Adw.SwitchRow({
            title: _('Ocultar al maximizar (intellihide)'),
            subtitle: _('Se oculta solo cuando una ventana cubre el dock; se revela en el borde'),
        });
        settings.bind('intellihide', intelliRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(intelliRow);

        // Reservar espacio
        const reserveRow = new Adw.SwitchRow({
            title: _('Reservar espacio'),
            subtitle: _('Las ventanas no se superponen al dock (queda siempre visible; anula el auto-ocultado)'),
        });
        settings.bind('reserve-space', reserveRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(reserveRow);

        // Favoritos
        const favRow = new Adw.SwitchRow({title: _('Mostrar aplicaciones favoritas')});
        settings.bind('show-favorites', favRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(favRow);

        // ---- Sonido de inicio ----
        const soundGroup = new Adw.PreferencesGroup({
            title: _('Sonido de inicio'),
            description: _('Reproduce un sonido cuando la extensión se carga al iniciar sesión.'),
        });
        page.add(soundGroup);

        const soundOnRow = new Adw.SwitchRow({
            title: _('Reproducir sonido al iniciar'),
        });
        settings.bind('startup-sound', soundOnRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        soundGroup.add(soundOnRow);

        const soundFileRow = new Adw.EntryRow({title: _('Archivo de sonido (vacío = sonido del sistema)')});
        soundFileRow.set_text(settings.get_string('startup-sound-file'));
        soundFileRow.connect('changed', () => {
            settings.set_string('startup-sound-file', soundFileRow.get_text().trim());
        });

        // Botón: elegir archivo de audio
        const pickSoundBtn = new Gtk.Button({icon_name: 'document-open-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat']});
        pickSoundBtn.set_tooltip_text(_('Elegir archivo de sonido…'));
        pickSoundBtn.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({title: _('Elegir sonido')});
            const filter = new Gtk.FileFilter();
            filter.set_name(_('Audio'));
            ['audio/ogg', 'audio/x-wav', 'audio/wav', 'audio/mpeg', 'audio/flac', 'audio/x-flac'].forEach(m => filter.add_mime_type(m));
            dialog.set_default_filter(filter);
            dialog.open(window, null, (dlg, res) => {
                try {
                    const f = dlg.open_finish(res);
                    if (f)
                        soundFileRow.set_text(f.get_path());
                } catch (_e) { /* cancelado */ }
            });
        });
        soundFileRow.add_suffix(pickSoundBtn);

        // Botón: limpiar (usar sonido del sistema)
        const clearSoundBtn = new Gtk.Button({icon_name: 'edit-clear-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat']});
        clearSoundBtn.set_tooltip_text(_('Usar sonido del sistema'));
        clearSoundBtn.connect('clicked', () => soundFileRow.set_text(''));
        soundFileRow.add_suffix(clearSoundBtn);

        // Botón: probar sonido
        const testSoundBtn = new Gtk.Button({icon_name: 'media-playback-start-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat']});
        testSoundBtn.set_tooltip_text(_('Probar sonido'));
        testSoundBtn.connect('clicked', () => this._playTestSound(soundFileRow.get_text().trim()));
        soundFileRow.add_suffix(testSoundBtn);

        soundGroup.add(soundFileRow);

        // ---- Sonido al cerrar sesión ----
        const shutOnRow = new Adw.SwitchRow({
            title: _('Reproducir sonido al cerrar sesión'),
            subtitle: _('Al salir el audio se cierra rápido; puede no sonar siempre'),
        });
        settings.bind('shutdown-sound', shutOnRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        soundGroup.add(shutOnRow);

        const shutFileRow = new Adw.EntryRow({title: _('Archivo de sonido de cierre (vacío = sonido del sistema)')});
        shutFileRow.set_text(settings.get_string('shutdown-sound-file'));
        shutFileRow.connect('changed', () => {
            settings.set_string('shutdown-sound-file', shutFileRow.get_text().trim());
        });
        const pickShutBtn = new Gtk.Button({icon_name: 'document-open-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat']});
        pickShutBtn.set_tooltip_text(_('Elegir archivo de sonido…'));
        pickShutBtn.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({title: _('Elegir sonido')});
            const filter = new Gtk.FileFilter();
            filter.set_name(_('Audio'));
            ['audio/ogg', 'audio/x-wav', 'audio/wav', 'audio/mpeg', 'audio/flac', 'audio/x-flac'].forEach(m => filter.add_mime_type(m));
            dialog.set_default_filter(filter);
            dialog.open(window, null, (dlg, res) => {
                try {
                    const f = dlg.open_finish(res);
                    if (f)
                        shutFileRow.set_text(f.get_path());
                } catch (_e) { /* cancelado */ }
            });
        });
        shutFileRow.add_suffix(pickShutBtn);
        const clearShutBtn = new Gtk.Button({icon_name: 'edit-clear-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat']});
        clearShutBtn.set_tooltip_text(_('Usar sonido del sistema'));
        clearShutBtn.connect('clicked', () => shutFileRow.set_text(''));
        shutFileRow.add_suffix(clearShutBtn);
        const testShutBtn = new Gtk.Button({icon_name: 'media-playback-start-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat']});
        testShutBtn.set_tooltip_text(_('Probar sonido'));
        testShutBtn.connect('clicked', () => this._playTestSound(shutFileRow.get_text().trim()));
        shutFileRow.add_suffix(testShutBtn);
        soundGroup.add(shutFileRow);

        // ---- Apps en ejecución (taskbar) ----
        const runGroup = new Adw.PreferencesGroup({
            title: _('Aplicaciones en ejecución'),
            description: _('Muestra las apps abiertas en el dock, agrupadas por aplicación.'),
        });
        page.add(runGroup);

        const runShowRow = new Adw.SwitchRow({
            title: _('Mostrar apps en ejecución'),
            subtitle: _('Incluye en el dock las apps abiertas que no son favoritas'),
        });
        settings.bind('show-running', runShowRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        runGroup.add(runShowRow);

        const runDotRow = new Adw.SwitchRow({
            title: _('Punto indicador de ejecución'),
            subtitle: _('Un punto bajo la app abierta (más puntos = más ventanas)'),
        });
        settings.bind('running-indicators', runDotRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        runGroup.add(runDotRow);

        const previewRow = new Adw.SwitchRow({
            title: _('Miniaturas de ventanas'),
            subtitle: _('Al pasar el ratón sobre una app abierta, muestra sus ventanas'),
        });
        settings.bind('window-previews', previewRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        runGroup.add(previewRow);

        // ---- Botón de menú de aplicaciones ----
        const appsGroup = new Adw.PreferencesGroup({
            title: _('Botón de aplicaciones'),
            description: _('Un botón que abre la cuadrícula de aplicaciones (estilo Launchpad).'),
        });
        page.add(appsGroup);

        const appsShowRow = new Adw.SwitchRow({title: _('Mostrar botón de aplicaciones')});
        settings.bind('show-apps-button', appsShowRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        appsGroup.add(appsShowRow);

        const abPosModel = new Gtk.StringList();
        [_('Inicio'), _('Final')].forEach(s => abPosModel.append(s));
        const abPosKeys = ['start', 'end'];
        const abPosRow = new Adw.ComboRow({
            title: _('Posición del botón'),
            model: abPosModel,
            selected: Math.max(0, abPosKeys.indexOf(settings.get_string('apps-button-position'))),
        });
        abPosRow.connect('notify::selected', () => {
            settings.set_string('apps-button-position', abPosKeys[abPosRow.selected]);
        });
        appsGroup.add(abPosRow);

        const gridRow = new Adw.SwitchRow({
            title: _('Rejilla de aplicaciones propia'),
            subtitle: _('Al pulsar el botón, abre una rejilla propia (tipo Launchpad) en vez del overview de GNOME'),
        });
        settings.bind('custom-app-grid', gridRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        appsGroup.add(gridRow);

        // Efecto genie al abrir/cerrar la rejilla
        const genieRow = new Adw.SwitchRow({
            title: _('Efecto genie al abrir/cerrar'),
            subtitle: _('La rejilla crece o se encoge desde el botón de menú (estilo genio de macOS)'),
        });
        settings.bind('appgrid-genie', genieRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        appsGroup.add(genieRow);

        // Tema de la rejilla (claro/oscuro)
        const themeModel = new Gtk.StringList();
        [_('Oscuro'), _('Claro')].forEach(s => themeModel.append(s));
        const themeKeys = ['dark', 'light'];
        const themeRow = new Adw.ComboRow({
            title: _('Tema de la rejilla'),
            model: themeModel,
            selected: Math.max(0, themeKeys.indexOf(settings.get_string('appgrid-theme'))),
        });
        themeRow.connect('notify::selected', () => {
            settings.set_string('appgrid-theme', themeKeys[themeRow.selected]);
        });
        appsGroup.add(themeRow);

        // Opacidad de los marcos interiores de la rejilla
        const gridOpRow = new Adw.SpinRow({
            title: _('Opacidad de la rejilla (%)'),
            subtitle: _('Transparencia de los marcos interiores (categorías y apps)'),
            adjustment: new Gtk.Adjustment({lower: 0, upper: 100, step_increment: 5, value: settings.get_int('appgrid-opacity')}),
        });
        settings.bind('appgrid-opacity', gridOpRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        appsGroup.add(gridOpRow);

        // Icono personalizado (nombre de icono o ruta de archivo)
        const iconEntryRow = new Adw.EntryRow({title: _('Icono (nombre o ruta)')});
        iconEntryRow.set_text(settings.get_string('apps-button-icon'));
        iconEntryRow.connect('changed', () => {
            settings.set_string('apps-button-icon', iconEntryRow.get_text().trim());
        });

        // Vista previa del icono actual
        const preview = new Gtk.Image({pixel_size: 24, valign: Gtk.Align.CENTER});
        const refreshPreview = () => {
            try {
                preview.set_from_gicon(Gio.icon_new_for_string(
                    settings.get_string('apps-button-icon') || 'view-app-grid-symbolic'));
            } catch (_e) {
                preview.set_from_icon_name('image-missing-symbolic');
            }
        };
        refreshPreview();
        settings.connect('changed::apps-button-icon', refreshPreview);
        iconEntryRow.add_prefix(preview);

        // Botón para elegir un archivo de imagen
        const pickIconBtn = new Gtk.Button({icon_name: 'document-open-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat']});
        pickIconBtn.set_tooltip_text(_('Elegir archivo de imagen…'));
        pickIconBtn.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({title: _('Elegir icono')});
            const filter = new Gtk.FileFilter();
            filter.set_name(_('Imágenes'));
            ['image/png', 'image/svg+xml', 'image/jpeg', 'image/x-icon'].forEach(m => filter.add_mime_type(m));
            dialog.set_default_filter(filter);
            dialog.open(window, null, (dlg, res) => {
                try {
                    const file = dlg.open_finish(res);
                    if (file) {
                        const path = file.get_path();
                        settings.set_string('apps-button-icon', path);
                        iconEntryRow.set_text(path);
                    }
                } catch (_e) { /* cancelado */ }
            });
        });
        iconEntryRow.add_suffix(pickIconBtn);

        // Botón restablecer icono por defecto
        const resetIconBtn = new Gtk.Button({icon_name: 'edit-undo-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat']});
        resetIconBtn.set_tooltip_text(_('Restablecer icono por defecto'));
        resetIconBtn.connect('clicked', () => {
            settings.set_string('apps-button-icon', 'view-app-grid-symbolic');
            iconEntryRow.set_text('view-app-grid-symbolic');
        });
        iconEntryRow.add_suffix(resetIconBtn);

        appsGroup.add(iconEntryRow);

        // ---- Integración con GNOME ----
        const gnomeGroup = new Adw.PreferencesGroup({
            title: _('Integración con GNOME'),
            description: _('Evita conflictos con el dock/menú nativo mientras Dock Stack está activo.'),
        });
        page.add(gnomeGroup);

        const dtdRow = new Adw.SwitchRow({
            title: _('Desactivar Dash to Dock'),
            subtitle: _('Se rehabilita automáticamente al desactivar Dock Stack'),
        });
        settings.bind('disable-dash-to-dock', dtdRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        gnomeGroup.add(dtdRow);

        const dashRow = new Adw.SwitchRow({
            title: _('Ocultar dash y botón de apps nativos'),
            subtitle: _('Oculta la barra de favoritos de la vista de Actividades'),
        });
        settings.bind('hide-overview-dash', dashRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        gnomeGroup.add(dashRow);

        const systrayRow = new Adw.SwitchRow({
            title: _('Iconos de bandeja (systray) integrados'),
            subtitle: _('Muestra en el top bar los iconos de bandeja de las apps (host SNI propio de Dock Stack)'),
        });
        settings.bind('systray', systrayRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        gnomeGroup.add(systrayRow);

        const aiRow = new Adw.SwitchRow({
            title: _('Usar extensión AppIndicator (si está instalada)'),
            subtitle: _('Alternativa al systray propio; desactiva el de arriba si usas esta para evitar conflictos'),
        });
        settings.bind('enable-appindicator', aiRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        gnomeGroup.add(aiRow);

        // Grupo stacks
        const sgroup = new Adw.PreferencesGroup({title: _('Despliegue de stacks')});
        page.add(sgroup);

        // Estilo de despliegue: grilla o abanico
        const styleModel = new Gtk.StringList();
        [_('Grilla'), _('Abanico (estilo macOS)')].forEach(s => styleModel.append(s));
        const styleKeys = ['grid', 'fan'];
        const styleRow = new Adw.ComboRow({
            title: _('Estilo de despliegue'),
            subtitle: _('Cómo se muestran los elementos al abrir un stack'),
            model: styleModel,
            selected: Math.max(0, styleKeys.indexOf(settings.get_string('stack-style'))),
        });
        styleRow.connect('notify::selected', () => {
            settings.set_string('stack-style', styleKeys[styleRow.selected]);
        });
        sgroup.add(styleRow);

        // Curvatura del abanico
        const curveRow = new Adw.SpinRow({
            title: _('Curvatura del abanico (px)'),
            subtitle: _('0 = tira recta vertical; más alto = más curva'),
            adjustment: new Gtk.Adjustment({lower: 0, upper: 220, step_increment: 5, value: settings.get_int('fan-curve')}),
        });
        settings.bind('fan-curve', curveRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        sgroup.add(curveRow);

        // Orden de los elementos del stack (ascendente / descendente)
        const sortModel = new Gtk.StringList();
        [_('Ascendente (A→Z)'), _('Descendente (Z→A)')].forEach(s => sortModel.append(s));
        const sortKeys = ['asc', 'desc'];
        const sortRow = new Adw.ComboRow({
            title: _('Orden de los elementos'),
            subtitle: _('Cómo se ordenan las apps/archivos dentro del stack'),
            model: sortModel,
            selected: Math.max(0, sortKeys.indexOf(settings.get_string('stack-sort'))),
        });
        sortRow.connect('notify::selected', () => {
            settings.set_string('stack-sort', sortKeys[sortRow.selected]);
        });
        sgroup.add(sortRow);

        // Mostrar u ocultar el icono de cada elemento del stack
        const showIconRow = new Adw.SwitchRow({
            title: _('Mostrar icono en los stacks'),
            subtitle: _('Muestra el icono de cada app/archivo en el stack desplegado'),
        });
        settings.bind('stack-show-icon', showIconRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        sgroup.add(showIconRow);

        // Posición del icono respecto al texto (izquierda / derecha) — modo abanico
        const iconPosModel = new Gtk.StringList();
        [_('Izquierda'), _('Derecha')].forEach(s => iconPosModel.append(s));
        const iconPosKeys = ['left', 'right'];
        const iconPosRow = new Adw.ComboRow({
            title: _('Posición del icono'),
            subtitle: _('Icono a la izquierda o derecha del texto (modo abanico)'),
            model: iconPosModel,
            selected: Math.max(0, iconPosKeys.indexOf(settings.get_string('stack-icon-position'))),
        });
        iconPosRow.connect('notify::selected', () => {
            settings.set_string('stack-icon-position', iconPosKeys[iconPosRow.selected]);
        });
        sgroup.add(iconPosRow);

        const colRow = new Adw.SpinRow({
            title: _('Columnas máximas'),
            adjustment: new Gtk.Adjustment({lower: 1, upper: 8, step_increment: 1, value: settings.get_int('stack-columns')}),
        });
        settings.bind('stack-columns', colRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        sgroup.add(colRow);

        const maxRow = new Adw.SpinRow({
            title: _('Máx. elementos (stack de carpeta)'),
            adjustment: new Gtk.Adjustment({lower: 5, upper: 200, step_increment: 5, value: settings.get_int('stack-max-items')}),
        });
        settings.bind('stack-max-items', maxRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        sgroup.add(maxRow);
    }

    // ------------------------------------------------------------- Stacks
    _buildStacksPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: _('Stacks'),
            icon_name: 'view-grid-symbolic',
        });
        window.add(page);
        if (this._prefPages) this._prefPages.push(page);

        const listGroup = new Adw.PreferencesGroup({
            title: _('Agrupaciones'),
            description: _('Carpetas o grupos de apps que se despliegan en el dock, estilo macOS.'),
        });
        page.add(listGroup);
        this._listGroup = listGroup;
        this._window = window;
        this._settings = settings;

        // Botones de creación
        const actionGroup = new Adw.PreferencesGroup();
        page.add(actionGroup);

        const addFolderRow = new Adw.ActionRow({
            title: _('Añadir stack de carpeta'),
            subtitle: _('Despliega el contenido de una carpeta (Descargas, Documentos, …)'),
            activatable: true,
        });
        addFolderRow.add_suffix(new Gtk.Image({icon_name: 'folder-new-symbolic'}));
        addFolderRow.connect('activated', () => this._addFolderStack());
        actionGroup.add(addFolderRow);

        const addAppsRow = new Adw.ActionRow({
            title: _('Añadir grupo de apps'),
            subtitle: _('Agrupa varias aplicaciones bajo un solo icono'),
            activatable: true,
        });
        addAppsRow.add_suffix(new Gtk.Image({icon_name: 'list-add-symbolic'}));
        addAppsRow.connect('activated', () => this._addAppGroup());
        actionGroup.add(addAppsRow);

        this._refreshStackList();
    }

    _refreshStackList() {
        // Quitar filas previas
        if (this._rows) {
            for (const r of this._rows)
                this._listGroup.remove(r);
        }
        this._rows = [];

        const stacks = readStacks(this._settings);
        if (stacks.length === 0) {
            const empty = new Adw.ActionRow({title: _('Aún no hay stacks'), subtitle: _('Usa los botones de abajo para crear uno')});
            this._listGroup.add(empty);
            this._rows.push(empty);
            return;
        }

        stacks.forEach((stack, index) => {
            const subtitle = stack.type === 'folder'
                ? `Carpeta · ${stack.path || ''}`
                : `Grupo de apps · ${(stack.apps || []).length} app(s)`;
            const row = new Adw.ActionRow({title: stack.name, subtitle});

            // Vista previa del icono del stack
            const prev = new Gtk.Image({pixel_size: 24, valign: Gtk.Align.CENTER});
            try {
                if (stack.icon)
                    prev.set_from_gicon(Gio.icon_new_for_string(stack.icon));
                else
                    prev.set_from_icon_name(stack.type === 'folder' ? 'folder-symbolic' : 'view-grid-symbolic');
            } catch (_e) {
                prev.set_from_icon_name('image-missing-symbolic');
            }
            row.add_prefix(prev);

            // Editar
            const editBtn = new Gtk.Button({icon_name: 'document-edit-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat']});
            editBtn.connect('clicked', () => this._openStackEditor(index));
            row.add_suffix(editBtn);

            // Subir
            const upBtn = new Gtk.Button({icon_name: 'go-up-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'], sensitive: index > 0});
            upBtn.connect('clicked', () => this._moveStack(index, -1));
            row.add_suffix(upBtn);

            // Bajar
            const downBtn = new Gtk.Button({icon_name: 'go-down-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'], sensitive: index < stacks.length - 1});
            downBtn.connect('clicked', () => this._moveStack(index, 1));
            row.add_suffix(downBtn);

            // Borrar
            const delBtn = new Gtk.Button({icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat', 'error']});
            delBtn.connect('clicked', () => this._deleteStack(index));
            row.add_suffix(delBtn);

            this._listGroup.add(row);
            this._rows.push(row);
        });
    }

    _moveStack(index, dir) {
        const stacks = readStacks(this._settings);
        const ni = index + dir;
        if (ni < 0 || ni >= stacks.length)
            return;
        const [item] = stacks.splice(index, 1);
        stacks.splice(ni, 0, item);
        writeStacks(this._settings, stacks);
        this._refreshStackList();
    }

    _deleteStack(index) {
        const stacks = readStacks(this._settings);
        stacks.splice(index, 1);
        writeStacks(this._settings, stacks);
        this._refreshStackList();
    }

    _addFolderStack() {
        const dialog = new Gtk.FileDialog({title: _('Elige una carpeta')});
        dialog.select_folder(this._window, null, (dlg, res) => {
            let folder;
            try {
                folder = dlg.select_folder_finish(res);
            } catch (_e) {
                return; // cancelado
            }
            if (!folder)
                return;
            const path = folder.get_path();
            const name = folder.get_basename();
            const stacks = readStacks(this._settings);
            stacks.push({id: uuidv4(), name, type: 'folder', path});
            writeStacks(this._settings, stacks);
            this._refreshStackList();
        });
    }

    _addAppGroup() {
        this._promptText(_('Nombre del grupo'), _('Mis apps'), (name) => {
            if (!name)
                return;
            this._pickApps([], (apps) => {
                const stacks = readStacks(this._settings);
                stacks.push({id: uuidv4(), name, type: 'apps', apps});
                writeStacks(this._settings, stacks);
                this._refreshStackList();
            });
        });
    }

    _openStackEditor(index) {
        const stacks = readStacks(this._settings);
        const stack = stacks[index];
        if (!stack)
            return;

        const win = new Adw.Window({
            transient_for: this._window,
            modal: true,
            title: _('Editar stack'),
            default_width: 500,
            default_height: 480,
        });
        const toolbar = new Adw.ToolbarView();
        const header = new Adw.HeaderBar();
        const saveBtn = new Gtk.Button({label: _('Guardar'), css_classes: ['suggested-action']});
        header.pack_end(saveBtn);
        toolbar.add_top_bar(header);

        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup();
        page.add(group);

        // Nombre
        const nameRow = new Adw.EntryRow({title: _('Nombre')});
        nameRow.set_text(stack.name || '');
        group.add(nameRow);

        // Icono en el dock (personalizable)
        const iconRow = new Adw.EntryRow({title: _('Icono en el dock (nombre o ruta; vacío = automático)')});
        iconRow.set_text(stack.icon || '');
        const preview = new Gtk.Image({pixel_size: 24, valign: Gtk.Align.CENTER});
        const refreshPrev = () => {
            const spec = iconRow.get_text().trim();
            try {
                if (spec)
                    preview.set_from_gicon(Gio.icon_new_for_string(spec));
                else
                    preview.set_from_icon_name(stack.type === 'folder' ? 'folder-symbolic' : 'view-grid-symbolic');
            } catch (_e) {
                preview.set_from_icon_name('image-missing-symbolic');
            }
        };
        refreshPrev();
        iconRow.connect('changed', refreshPrev);
        iconRow.add_prefix(preview);
        const pickBtn = new Gtk.Button({icon_name: 'document-open-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat']});
        pickBtn.set_tooltip_text(_('Elegir archivo de imagen…'));
        pickBtn.connect('clicked', () => {
            const d = new Gtk.FileDialog({title: _('Elegir icono')});
            const filter = new Gtk.FileFilter();
            filter.set_name(_('Imágenes'));
            ['image/png', 'image/svg+xml', 'image/jpeg', 'image/x-icon'].forEach(m => filter.add_mime_type(m));
            d.set_default_filter(filter);
            d.open(win, null, (dlg, res) => {
                try {
                    const f = dlg.open_finish(res);
                    if (f)
                        iconRow.set_text(f.get_path());
                } catch (_e) { /* cancelado */ }
            });
        });
        iconRow.add_suffix(pickBtn);
        const clearBtn = new Gtk.Button({icon_name: 'edit-clear-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat']});
        clearBtn.set_tooltip_text(_('Icono automático'));
        clearBtn.connect('clicked', () => iconRow.set_text(''));
        iconRow.add_suffix(clearBtn);
        group.add(iconRow);

        // Estilo de despliegue por stack
        const styleModel = new Gtk.StringList();
        [_('Predeterminado'), _('Grilla'), _('Abanico')].forEach(s => styleModel.append(s));
        const styleKeys = ['', 'grid', 'fan'];
        const styleRow = new Adw.ComboRow({
            title: _('Estilo de despliegue'),
            model: styleModel,
            selected: Math.max(0, styleKeys.indexOf(stack.style || '')),
        });
        group.add(styleRow);

        // Contenido según tipo
        const contentGroup = new Adw.PreferencesGroup({
            title: stack.type === 'folder' ? _('Carpeta') : _('Aplicaciones'),
        });
        page.add(contentGroup);

        let currentPath = stack.path;
        let currentApps = (stack.apps || []).slice();
        if (stack.type === 'folder') {
            const pathRow = new Adw.ActionRow({title: _('Carpeta'), subtitle: currentPath || ''});
            const changeBtn = new Gtk.Button({label: _('Cambiar…'), valign: Gtk.Align.CENTER});
            changeBtn.connect('clicked', () => {
                const d = new Gtk.FileDialog({title: _('Elegir carpeta')});
                d.select_folder(win, null, (dlg, res) => {
                    try {
                        const f = dlg.select_folder_finish(res);
                        if (f) {
                            currentPath = f.get_path();
                            pathRow.set_subtitle(currentPath);
                        }
                    } catch (_e) { /* mantener */ }
                });
            });
            pathRow.add_suffix(changeBtn);
            contentGroup.add(pathRow);
        } else {
            const appsRow = new Adw.ActionRow({title: _('Aplicaciones'), subtitle: `${currentApps.length} seleccionada(s)`});
            const manageBtn = new Gtk.Button({label: _('Gestionar…'), valign: Gtk.Align.CENTER});
            manageBtn.connect('clicked', () => {
                this._pickApps(currentApps, (apps) => {
                    currentApps = apps;
                    appsRow.set_subtitle(`${apps.length} seleccionada(s)`);
                });
            });
            appsRow.add_suffix(manageBtn);
            contentGroup.add(appsRow);
        }

        toolbar.set_content(page);
        win.set_content(toolbar);

        saveBtn.connect('clicked', () => {
            const all = readStacks(this._settings);
            const s = all[index];
            if (s) {
                s.name = nameRow.get_text().trim() || s.name;
                const iconSpec = iconRow.get_text().trim();
                if (iconSpec)
                    s.icon = iconSpec;
                else
                    delete s.icon;
                const st = styleKeys[styleRow.selected];
                if (st)
                    s.style = st;
                else
                    delete s.style;
                if (s.type === 'folder')
                    s.path = currentPath;
                else
                    s.apps = currentApps;
                writeStacks(this._settings, all);
                this._refreshStackList();
            }
            win.destroy();
        });

        win.present();
    }

    // ------------------------------------------------------------- helpers UI
    _promptText(title, initial, callback) {
        const dialog = new Adw.MessageDialog({
            transient_for: this._window,
            modal: true,
            heading: title,
        });
        const entry = new Gtk.Entry({text: initial || '', hexpand: true, margin_top: 8, margin_bottom: 8, margin_start: 8, margin_end: 8});
        dialog.set_extra_child(entry);
        dialog.add_response('cancel', _('Cancelar'));
        dialog.add_response('ok', _('Aceptar'));
        dialog.set_default_response('ok');
        dialog.set_response_appearance('ok', Adw.ResponseAppearance.SUGGESTED);
        dialog.connect('response', (d, resp) => {
            if (resp === 'ok')
                callback(entry.get_text().trim());
            d.destroy();
        });
        dialog.present();
    }

    _pickApps(preselected, callback) {
        const win = new Adw.Window({
            transient_for: this._window,
            modal: true,
            title: _('Elegir aplicaciones'),
            default_width: 460,
            default_height: 560,
        });
        const toolbar = new Adw.ToolbarView();
        const header = new Adw.HeaderBar();
        const doneBtn = new Gtk.Button({label: _('Listo'), css_classes: ['suggested-action']});
        header.pack_end(doneBtn);
        toolbar.add_top_bar(header);

        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
        const search = new Gtk.SearchEntry({margin_top: 8, margin_start: 8, margin_end: 8});
        box.append(search);

        const scroll = new Gtk.ScrolledWindow({vexpand: true, margin_start: 8, margin_end: 8, margin_bottom: 8});
        const listBox = new Gtk.ListBox({css_classes: ['boxed-list'], selection_mode: Gtk.SelectionMode.NONE});
        scroll.set_child(listBox);
        box.append(scroll);
        toolbar.set_content(box);
        win.set_content(toolbar);

        const selected = new Set(preselected);
        const apps = Gio.AppInfo.get_all()
            .filter(a => a.should_show())
            .sort((a, b) => a.get_display_name().localeCompare(b.get_display_name()));

        const rows = [];
        for (const app of apps) {
            const id = app.get_id();
            const row = new Adw.ActionRow({title: app.get_display_name()});
            const gicon = app.get_icon();
            if (gicon)
                row.add_prefix(new Gtk.Image({gicon, pixel_size: 24}));
            const check = new Gtk.CheckButton({active: selected.has(id), valign: Gtk.Align.CENTER});
            check.connect('toggled', () => {
                if (check.active)
                    selected.add(id);
                else
                    selected.delete(id);
            });
            row.add_suffix(check);
            row.activatable_widget = check;
            row._searchName = app.get_display_name().toLowerCase();
            listBox.append(row);
            rows.push(row);
        }

        search.connect('search-changed', () => {
            const q = search.get_text().toLowerCase();
            for (const r of rows)
                r.visible = !q || r._searchName.includes(q);
        });

        doneBtn.connect('clicked', () => {
            callback(Array.from(selected));
            win.destroy();
        });
        win.present();
    }
}
