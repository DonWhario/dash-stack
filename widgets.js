/* Dock Stack — dock widgets (cards shown in the bar next to the app icons).
 *
 * A widget is a small, self-contained card fed by a data source:
 *   - mpris   : now-playing card (title/artist/art + play/pause/prev/next).
 *   - weather : location, temperature and condition (via wttr.in).
 *   - system  : clock plus CPU / RAM / battery.
 *   - script  : the first line of a user command's output, refreshed.
 *
 * GNOME/Wayland does not allow embedding another app's UI, so these are native
 * cards drawn by the extension; the "external" part is the data (a player over
 * MPRIS, a web API, or the user's own script).
 *
 * makeWidget(spec, iconSize, _) returns {actor, destroy}. `destroy` MUST be
 * called by the caller when the dock is rebuilt so timers/D-Bus stay clean.
 */

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const CENTER = Clutter.ActorAlign.CENTER;

// Dock background opacity (0..1), kept in sync by the extension so the popups
// (forecast, calendar) match the dock's opacity.
let dockOpacity = 0.65;
export function setDockOpacity(op) {
    if (typeof op === 'number' && op >= 0 && op <= 1)
        dockOpacity = op;
}

function card(extra) {
    return new St.BoxLayout({
        style_class: 'dock-widget ' + (extra || ''),
        reactive: true,
        y_align: CENTER,
    });
}

function textColumn(titleText, subText) {
    const col = new St.BoxLayout({
        style_class: 'dock-widget-text',
        vertical: true,
        y_align: CENTER,
    });
    const title = new St.Label({style_class: 'dock-widget-title', text: titleText || ''});
    title.clutter_text.set_ellipsize(3 /* END */);
    const sub = new St.Label({style_class: 'dock-widget-sub', text: subText || ''});
    sub.clutter_text.set_ellipsize(3);
    col.add_child(title);
    col.add_child(sub);
    return {col, title, sub};
}

export function makeWidget(spec, iconSize, _, lang, hooks) {
    switch (spec && spec.type) {
    case 'mpris': return makeMpris(spec, iconSize, _);
    case 'weather': return makeWeather(spec, iconSize, _, lang, hooks);
    case 'system': return makeSystem(spec, iconSize, _);
    case 'clock': return makeClock(spec, iconSize, _);
    case 'script': return makeScript(spec, iconSize, _);
    default: return makePlaceholder(_);
    }
}

function makePlaceholder(_) {
    const box = card();
    box.add_child(new St.Label({style_class: 'dock-widget-title', text: _('Widget')}));
    return {actor: box, destroy() {}};
}

// --------------------------------------------------------------------- MPRIS
const MPRIS_IFACE = 'org.mpris.MediaPlayer2.Player';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';

function makeMpris(spec, iconSize, _) {
    const box = card('dock-widget-mpris');
    setCardBg(box, 'reproduciendo.png');
    const art = new St.Icon({
        style_class: 'dock-widget-art',
        icon_name: 'audio-x-generic-symbolic',
        icon_size: iconSize,
    });
    const {col, title, sub} = textColumn(_('Nada reproduciéndose'), '');
    setFlexWidth(col, 150);

    const controls = new St.BoxLayout({style_class: 'dock-widget-ctl', y_align: CENTER});
    const mkBtn = (iconName, method) => {
        const b = new St.Button({
            style_class: 'dock-widget-btn',
            child: new St.Icon({icon_name: iconName, icon_size: 16}),
        });
        b.connect('clicked', () => callPlayer(method));
        return b;
    };
    const prevB = mkBtn('media-skip-backward-symbolic', 'Previous');
    const ppB = new St.Button({
        style_class: 'dock-widget-btn',
        child: new St.Icon({icon_name: 'media-playback-start-symbolic', icon_size: 16}),
    });
    ppB.connect('clicked', () => callPlayer('PlayPause'));
    const nextB = mkBtn('media-skip-forward-symbolic', 'Next');
    controls.add_child(prevB);
    controls.add_child(ppB);
    controls.add_child(nextB);

    box.add_child(art);
    box.add_child(col);
    box.add_child(controls);

    const bus = Gio.DBus.session;
    let proxy = null;
    let busName = null;
    let propsId = 0;
    let timer = 0;

    const callPlayer = (method) => {
        if (proxy) {
            try {
                proxy.call(method, null, Gio.DBusCallFlags.NONE, -1, null, null);
            } catch (_e) { /* player went away */ }
        }
    };

    const mkProxy = (name) => Gio.DBusProxy.new_sync(
        bus, Gio.DBusProxyFlags.NONE, null, name, MPRIS_PATH, MPRIS_IFACE, null);

    const listPlayers = () => {
        try {
            const reply = bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus',
                'org.freedesktop.DBus', 'ListNames', null, null,
                Gio.DBusCallFlags.NONE, -1, null);
            return reply.deep_unpack()[0].filter(n => n.startsWith('org.mpris.MediaPlayer2.'));
        } catch (_e) {
            return [];
        }
    };

    const pick = () => {
        const names = listPlayers();
        let fallback = null;
        for (const n of names) {
            try {
                const p = mkProxy(n);
                const st = p.get_cached_property('PlaybackStatus');
                if (st && st.unpack() === 'Playing')
                    return {name: n, proxy: p};
                if (!fallback)
                    fallback = {name: n, proxy: p};
            } catch (_e) { /* skip */ }
        }
        return fallback;
    };

    const updateUI = () => {
        if (!proxy) {
            art.gicon = null;
            art.icon_name = 'audio-x-generic-symbolic';
            title.text = _('Nada reproduciéndose');
            sub.text = '';
            ppB.child.icon_name = 'media-playback-start-symbolic';
            return;
        }
        let t = '', a = '', url = '';
        const md = proxy.get_cached_property('Metadata');
        if (md) {
            const m = md.deep_unpack();
            if (m['xesam:title']) t = m['xesam:title'].deep_unpack();
            if (m['xesam:artist']) {
                const arr = m['xesam:artist'].deep_unpack();
                a = Array.isArray(arr) ? arr.join(', ') : String(arr);
            }
            if (m['mpris:artUrl']) url = m['mpris:artUrl'].deep_unpack();
        }
        title.text = t || _('Nada reproduciéndose');
        sub.text = a;
        if (url && url.startsWith('file://')) {
            try {
                art.gicon = new Gio.FileIcon({file: Gio.File.new_for_uri(url)});
            } catch (_e) {
                art.gicon = null;
                art.icon_name = 'audio-x-generic-symbolic';
            }
        } else {
            art.gicon = null;
            art.icon_name = 'audio-x-generic-symbolic';
        }
        const st = proxy.get_cached_property('PlaybackStatus');
        const playing = st && st.unpack() === 'Playing';
        ppB.child.icon_name = playing
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';
    };

    const bind = (sel) => {
        if (propsId && proxy) {
            try { proxy.disconnect(propsId); } catch (_e) { /* ok */ }
        }
        propsId = 0;
        proxy = sel ? sel.proxy : null;
        busName = sel ? sel.name : null;
        if (proxy)
            propsId = proxy.connect('g-properties-changed', () => updateUI());
        updateUI();
    };

    const refresh = () => {
        const sel = pick();
        if ((sel && sel.name) !== busName)
            bind(sel);
        else
            updateUI();
        return GLib.SOURCE_CONTINUE;
    };

    refresh();
    timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, refresh);

    return {
        actor: box,
        destroy() {
            if (timer) { GLib.source_remove(timer); timer = 0; }
            if (propsId && proxy) {
                try { proxy.disconnect(propsId); } catch (_e) { /* ok */ }
            }
            proxy = null;
        },
    };
}

// ------------------------------------------------------------------- Weather
// Bundled weather background images, resolved relative to this module so the
// extension is self-contained (…/dock-stack@felipe.local/data/).
function moduleDir() {
    try {
        const [file] = GLib.filename_from_uri(import.meta.url);
        return GLib.path_get_dirname(file);
    } catch (_e) {
        return '.';
    }
}
const DATA_DIR = GLib.build_filenamev([moduleDir(), 'data']);

// file:// URI for a bundled image in data/.
function dataUri(name) {
    return Gio.File.new_for_path(GLib.build_filenamev([DATA_DIR, name])).get_uri();
}

// Sets a static background image (from data/) on a widget card.
function setCardBg(box, name) {
    box.set_style(
        `background-image: url("${dataUri(name)}"); background-size: cover; ` +
        'background-position: center;');
}

// Variable width: the actor sizes to its content but is clamped to ±20% of a
// base width, so a widget can grow/shrink a little without getting too big or
// too small. Labels inside ellipsize when they hit the maximum.
function setFlexWidth(actor, base) {
    const min = Math.round(base * 0.8);
    const max = Math.round(base * 1.2);
    actor.set_style(`min-width: ${min}px; max-width: ${max}px;`);
}

// Calls `cb` on a left double-click of `actor`. Detected manually by timing two
// presses, because this Clutter build's event has no get_click_count().
function onDoubleClick(actor, cb) {
    let last = 0;
    actor.connect('button-press-event', (_a, ev) => {
        let button = 1;
        try { button = ev.get_button(); } catch (_e) { /* keep default */ }
        if (button !== 1)
            return Clutter.EVENT_PROPAGATE;
        let t = 0;
        try { t = ev.get_time(); } catch (_e) { t = 0; }
        if (!t)
            t = Math.floor(GLib.get_monotonic_time() / 1000);
        if (last && t - last < 400) {
            last = 0;
            cb();
            return Clutter.EVENT_STOP;
        }
        last = t;
        return Clutter.EVENT_PROPAGATE;
    });
}

// Maps a wttr.in weather code to a coarse condition category.
function weatherCategory(code) {
    const c = String(code || '');
    const has = (list) => list.includes(c);
    if (has(['200', '386', '389', '392', '395'])) return 'storm';
    if (has(['179', '182', '185', '227', '230', '317', '320', '323', '326', '329',
        '332', '335', '338', '350', '362', '365', '368', '371', '374', '377']))
        return 'snow';
    if (has(['176', '263', '266', '281', '284', '293', '296', '299', '302', '305',
        '308', '311', '314', '353', '356', '359']))
        return 'rain';
    if (has(['143', '248', '260'])) return 'fog';
    if (has(['119', '122'])) return 'cloudy';
    if (has(['116'])) return 'partly';
    return 'clear';
}

function weatherIcon(code) {
    switch (weatherCategory(code)) {
    case 'storm': return 'weather-storm-symbolic';
    case 'snow': return 'weather-snow-symbolic';
    case 'rain': return 'weather-showers-symbolic';
    case 'fog': return 'weather-fog-symbolic';
    case 'cloudy': return 'weather-overcast-symbolic';
    case 'partly': return 'weather-few-clouds-symbolic';
    default: return 'weather-clear-symbolic';
    }
}

// Background image (file:// URI) for the weather card, per the user's mapping.
function weatherBgUri(code) {
    const name = {
        clear: 'soleado.png',
        partly: 'parcial.png',
        cloudy: 'nublado.png',
        fog: 'nublado.png',      // no dedicated fog image → cloudy
        rain: 'lluvia.png',
        storm: 'lluvia.png',     // storm reuses the rain image
        snow: 'nieve.png',
    }[weatherCategory(code)] || 'soleado.png';
    return dataUri(name);
}

// Icon for an open-meteo WMO weather code (used in the 5-day forecast).
function wmoIcon(code) {
    const c = Number(code);
    if ([95, 96, 99].includes(c)) return 'weather-storm-symbolic';
    if ([71, 73, 75, 77, 85, 86].includes(c)) return 'weather-snow-symbolic';
    if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(c))
        return 'weather-showers-symbolic';
    if ([45, 48].includes(c)) return 'weather-fog-symbolic';
    if (c === 3) return 'weather-overcast-symbolic';
    if ([1, 2].includes(c)) return 'weather-few-clouds-symbolic';
    return 'weather-clear-symbolic';
}

// Shows `content` in a modal overlay (click outside / Escape closes). If
// `sourceActor` is given, it is placed next to it (above the dock); otherwise
// it is centered on the monitor.
function showPopup(content, sourceActor) {
    const overlay = new St.Widget({
        reactive: true, x: 0, y: 0,
        width: global.stage.width, height: global.stage.height,
    });
    const bg = new St.Widget({
        reactive: true, x: 0, y: 0,
        width: global.stage.width, height: global.stage.height,
    });
    let grab = null;
    const close = () => {
        if (grab) { Main.popModal(grab); grab = null; }
        overlay.destroy();
    };
    bg.connect('button-press-event', () => { close(); return Clutter.EVENT_STOP; });
    overlay.add_child(bg);
    overlay.connect('key-press-event', (_a, ev) => {
        if (ev.get_key_symbol() === Clutter.KEY_Escape)
            close();
        return Clutter.EVENT_STOP;
    });
    Main.layoutManager.uiGroup.add_child(overlay);
    grab = Main.pushModal(overlay, {actionMode: Shell.ActionMode.POPUP});
    overlay.grab_key_focus();

    overlay.add_child(content);
    // Match the dock's opacity.
    content.set_style(`background-color: rgba(30,30,30,${dockOpacity.toFixed(2)});`);
    content.connect('button-press-event', () => Clutter.EVENT_STOP);
    const monitor = Main.layoutManager.primaryMonitor;
    const [, w] = content.get_preferred_width(-1);
    const [, h] = content.get_preferred_height(w);
    let px, py;
    if (sourceActor && sourceActor.get_stage()) {
        const [bx, by] = sourceActor.get_transformed_position();
        px = bx + sourceActor.width / 2 - w / 2;   // centered over the widget
        py = by - h - 8;                           // above it
        if (py < monitor.y + 8)
            py = by + sourceActor.height + 8;      // below if no room above
    } else {
        px = monitor.x + (monitor.width - w) / 2;
        py = monitor.y + (monitor.height - h) / 2;
    }
    px = Math.max(monitor.x + 8, Math.min(px, monitor.x + monitor.width - w - 8));
    py = Math.max(monitor.y + 8, Math.min(py, monitor.y + monitor.height - h - 8));
    content.set_position(Math.round(px), Math.round(py));
    return {close};
}

// 5-day forecast popup (open-meteo) for the given coordinates, shown next to
// the weather widget (sourceActor) with a background image.
function openForecast(sourceActor, lat, lon, name, _) {
    const container = new St.BoxLayout({style_class: 'dock-forecast', vertical: true});
    const header = new St.Label({style_class: 'dock-forecast-title', text: name || _('Clima')});
    container.add_child(header);
    const rows = new St.BoxLayout({style_class: 'dock-forecast-rows', vertical: true});
    container.add_child(rows);

    // Pre-build the 5 rows synchronously (day + placeholder icon/temp) so the
    // popup's size is stable BEFORE positioning; the fetch then fills them in.
    const now = GLib.DateTime.new_now_local();
    const refs = [];
    for (let i = 0; i < 5; i++) {
        const dt = now.add_days(i);
        const row = new St.BoxLayout({style_class: 'dock-forecast-row'});
        const day = new St.Label({
            style_class: 'dock-forecast-day',
            text: i === 0 ? _('Hoy') : dt.format('%a %d'),
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        });
        const ic = new St.Icon({
            style_class: 'dock-forecast-icon',
            icon_name: 'weather-clear-symbolic',
            icon_size: 22,
        });
        const temp = new St.Label({style_class: 'dock-forecast-temp', text: '…'});
        row.add_child(day);
        row.add_child(ic);
        row.add_child(temp);
        rows.add_child(row);
        refs.push({ic, temp});
    }

    showPopup(container, sourceActor);

    if (lat == null || lon == null) {
        for (const r of refs)
            r.temp.text = _('sin datos');
        return;
    }

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
        '&daily=weathercode,temperature_2m_max,temperature_2m_min&forecast_days=5&timezone=auto';
    const session = new Soup.Session();
    let msg;
    try {
        msg = Soup.Message.new('GET', url);
    } catch (_e) {
        for (const r of refs)
            r.temp.text = _('sin datos');
        return;
    }
    session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
        try {
            const bytes = session.send_and_read_finish(res);
            const d = JSON.parse(new TextDecoder().decode(bytes.get_data())).daily;
            for (let i = 0; i < refs.length && i < d.time.length; i++) {
                refs[i].ic.icon_name = wmoIcon(d.weathercode[i]);
                refs[i].temp.text =
                    `${Math.round(d.temperature_2m_max[i])}° / ${Math.round(d.temperature_2m_min[i])}°`;
            }
        } catch (_e) {
            for (const r of refs)
                r.temp.text = _('sin datos');
        }
    });
}

// Own month calendar popup (double-click on the clock widget).
function openCalendar(sourceActor) {
    const now = GLib.DateTime.new_now_local();
    let viewY = now.get_year();
    let viewM = now.get_month();
    const todayY = now.get_year();
    const todayM = now.get_month();
    const todayD = now.get_day_of_month();

    const container = new St.BoxLayout({style_class: 'dock-calendar', vertical: true});
    const head = new St.BoxLayout({style_class: 'dock-calendar-head'});
    const prev = new St.Button({
        style_class: 'dock-calendar-nav',
        child: new St.Icon({icon_name: 'go-previous-symbolic', icon_size: 16}),
    });
    const titleL = new St.Label({
        style_class: 'dock-calendar-title',
        x_expand: true,
        x_align: CENTER,
        y_align: CENTER,
    });
    const next = new St.Button({
        style_class: 'dock-calendar-nav',
        child: new St.Icon({icon_name: 'go-next-symbolic', icon_size: 16}),
    });
    head.add_child(prev);
    head.add_child(titleL);
    head.add_child(next);
    container.add_child(head);

    const grid = new St.Widget({style_class: 'dock-calendar-grid'});
    const gl = new Clutter.GridLayout();
    gl.set_column_homogeneous(true);
    gl.set_column_spacing(2);
    gl.set_row_spacing(2);
    grid.set_layout_manager(gl);
    container.add_child(grid);

    const render = () => {
        grid.destroy_all_children();
        const first = GLib.DateTime.new_local(viewY, viewM, 1, 12, 0, 0);
        titleL.text = first.format('%B %Y');
        // Weekday headers (Monday-first; 2024-01-01 was a Monday).
        for (let i = 0; i < 7; i++) {
            const d = GLib.DateTime.new_local(2024, 1, 1 + i, 12, 0, 0);
            const l = new St.Label({
                style_class: 'dock-calendar-wd',
                text: d.format('%a'),
                x_expand: true,
                x_align: CENTER,
            });
            gl.attach(l, i, 0, 1, 1);
        }
        const startDow = first.get_day_of_week();   // 1=Mon .. 7=Sun
        const daysInMonth = first.add_months(1).add_days(-1).get_day_of_month();
        let col = startDow - 1;
        let row = 1;
        for (let day = 1; day <= daysInMonth; day++) {
            const cell = new St.Label({
                style_class: 'dock-calendar-day',
                text: String(day),
                x_expand: true,
                x_align: CENTER,
            });
            if (viewY === todayY && viewM === todayM && day === todayD)
                cell.add_style_class_name('today');
            gl.attach(cell, col, row, 1, 1);
            col++;
            if (col > 6) { col = 0; row++; }
        }
    };

    prev.connect('clicked', () => {
        viewM--;
        if (viewM < 1) { viewM = 12; viewY--; }
        render();
    });
    next.connect('clicked', () => {
        viewM++;
        if (viewM > 12) { viewM = 1; viewY++; }
        render();
    });
    render();
    showPopup(container, sourceActor);
}

function makeWeather(spec, iconSize, _, lang, hooks) {
    const box = card('dock-widget-weather');
    const icon = new St.Icon({
        style_class: 'dock-widget-art',
        icon_name: 'weather-clear-symbolic',
        icon_size: iconSize,
    });
    const loc = (spec.location || '').trim();
    const {col, title, sub} = textColumn(loc || _('Clima'), '…');
    setFlexWidth(col, 150);
    box.add_child(icon);
    box.add_child(col);

    // Double-click → 5-day forecast (uses coordinates from the last fetch).
    let lat = null;
    let lon = null;
    onDoubleClick(box, () => openForecast(box, lat, lon, title.text, _));

    const setBg = (uri) => box.set_style(
        `background-image: url("${uri}"); background-size: cover; background-position: center;`);

    // Initial background: the last one this widget showed (persisted), so a
    // rebuild/relaunch keeps the previous look instead of flashing. Only the
    // very first time ever it falls back to sunny.
    const soleado = dataUri('soleado.png');
    const cachedBg = hooks && spec.id ? hooks.getBg(spec.id) : null;
    const defaultBg = cachedBg || soleado;
    setBg(defaultBg);

    // wttr.in returns the description in English by default; request it in the
    // extension's language and read the translated `lang_<code>` field.
    const langCode = lang && lang !== 'en' ? lang : '';

    const session = new Soup.Session();
    let timer = 0;
    let lastBg = defaultBg;   // current background URI, to avoid reloading on refresh

    const fetch = () => {
        // With a location, use it; empty → wttr.in auto-detects it from the
        // connection (IP), so the widget also works without typing a city.
        const base = loc
            ? `https://wttr.in/${encodeURIComponent(loc)}`
            : 'https://wttr.in/';
        const url = langCode
            ? `${base}?format=j1&lang=${langCode}`
            : `${base}?format=j1`;
        let msg;
        try {
            msg = Soup.Message.new('GET', url);
        } catch (_e) {
            sub.text = _('sin datos');
            return;
        }
        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
            try {
                const bytes = session.send_and_read_finish(res);
                const data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                const cur = data.current_condition[0];
                const translated = langCode && cur['lang_' + langCode] && cur['lang_' + langCode][0]
                    ? cur['lang_' + langCode][0].value
                    : null;
                const desc = translated ||
                    (cur.weatherDesc && cur.weatherDesc[0] ? cur.weatherDesc[0].value : '');
                sub.text = `${cur.temp_C}°C · ${desc}`;
                icon.icon_name = weatherIcon(cur.weatherCode);
                if (data.nearest_area && data.nearest_area[0]) {
                    const na = data.nearest_area[0];
                    title.text = na.areaName[0].value;
                    lat = na.latitude;
                    lon = na.longitude;
                }
                // Condition background image behind the card content. Only
                // re-apply it when the condition (image) actually changes, so a
                // periodic refresh with the same weather doesn't reload the
                // texture and flicker; persist it as the widget's last look.
                const bg = weatherBgUri(cur.weatherCode);
                if (bg !== lastBg) {
                    lastBg = bg;
                    setBg(bg);
                    if (hooks && spec.id)
                        hooks.setBg(spec.id, bg);
                }
            } catch (_e) {
                sub.text = _('sin datos');
            }
        });
    };

    fetch();
    timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 900, () => { fetch(); return GLib.SOURCE_CONTINUE; });

    return {
        actor: box,
        destroy() {
            if (timer) { GLib.source_remove(timer); timer = 0; }
            try { session.abort(); } catch (_e) { /* ok */ }
        },
    };
}

// -------------------------------------------------------------------- System
function readFile(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (ok)
            return new TextDecoder().decode(bytes);
    } catch (_e) { /* ignore */ }
    return '';
}

function readCpu() {
    const line = readFile('/proc/stat').split('\n')[0];      // "cpu  u n s idle io irq ..."
    const p = line.trim().split(/\s+/).slice(1).map(Number);
    if (p.length < 4)
        return {idle: 0, total: 0};
    const idle = p[3] + (p[4] || 0);
    const total = p.reduce((a, b) => a + b, 0);
    return {idle, total};
}

function readRam() {
    const t = readFile('/proc/meminfo');
    const get = (k) => { const m = t.match(new RegExp(k + ':\\s+(\\d+)')); return m ? Number(m[1]) : 0; };
    const total = get('MemTotal');
    const avail = get('MemAvailable');
    if (!total)
        return 0;
    return Math.round((1 - avail / total) * 100);
}

function readBattery() {
    for (const bat of ['BAT0', 'BAT1', 'BATT']) {
        const cap = readFile(`/sys/class/power_supply/${bat}/capacity`).trim();
        if (cap !== '')
            return Number(cap);
    }
    return -1;
}

function makeSystem(spec, iconSize, _) {
    const box = card('dock-widget-system');
    setCardBg(box, 'sistemas.png');
    const show = spec.fields || {cpu: true, ram: true, battery: true};

    // Mini CPU-usage sparkline (last N samples).
    const SAMPLES = 30;
    const hist = new Array(SAMPLES).fill(0);
    const graphH = iconSize;
    const area = new St.DrawingArea({style_class: 'dock-widget-graph'});
    area.set_width(58);
    area.set_height(graphH);
    area.connect('repaint', () => {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const n = hist.length;
        const px = (i) => (n > 1 ? (w * i) / (n - 1) : 0);
        const py = (v) => h - (Math.max(0, Math.min(100, v)) / 100) * (h - 3) - 1.5;
        // Filled area under the curve.
        cr.moveTo(0, h);
        for (let i = 0; i < n; i++)
            cr.lineTo(px(i), py(hist[i]));
        cr.lineTo(w, h);
        cr.closePath();
        cr.setSourceRGBA(0.45, 0.72, 1.0, 0.18);
        cr.fill();
        // Line on top.
        cr.setLineWidth(1.5);
        cr.setSourceRGBA(0.55, 0.8, 1.0, 0.95);
        for (let i = 0; i < n; i++) {
            if (i === 0) cr.moveTo(px(i), py(hist[i]));
            else cr.lineTo(px(i), py(hist[i]));
        }
        cr.stroke();
        cr.$dispose();
    });

    const info = new St.BoxLayout({style_class: 'dock-widget-text', vertical: true, y_align: CENTER});
    const l1 = new St.Label({style_class: 'dock-widget-title'});
    const l2 = new St.Label({style_class: 'dock-widget-sub'});
    info.add_child(l1);
    info.add_child(l2);

    box.add_child(area);
    box.add_child(info);

    let lastCpu = readCpu();
    const tick = () => {
        const c = readCpu();
        const dt = c.total - lastCpu.total;
        const di = c.idle - lastCpu.idle;
        const use = dt > 0 ? Math.round((1 - di / dt) * 100) : 0;
        lastCpu = c;
        hist.push(use);
        hist.shift();
        area.queue_repaint();

        l1.text = show.cpu ? `CPU ${use}%` : _('Sistema');
        const parts = [];
        if (show.ram) parts.push(`RAM ${readRam()}%`);
        if (show.battery) { const b = readBattery(); if (b >= 0) parts.push(`BAT ${b}%`); }
        l2.text = parts.join('  ·  ');
        return GLib.SOURCE_CONTINUE;
    };
    tick();
    const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, tick);

    return {
        actor: box,
        destroy() { if (timer) GLib.source_remove(timer); },
    };
}

function makeClock(spec, iconSize, _) {
    const box = card('dock-widget-clock');
    setCardBg(box, 'reloj.png');
    const info = new St.BoxLayout({style_class: 'dock-widget-text', vertical: true, y_align: CENTER});
    const big = new St.Label({style_class: 'dock-widget-time'});
    const sub = new St.Label({style_class: 'dock-widget-sub'});
    info.add_child(big);
    info.add_child(sub);
    box.add_child(info);

    // Double-click → open our own month calendar (above the clock widget).
    onDoubleClick(box, () => openCalendar(box));

    const fmt24 = spec.format24 !== false;   // default 24h
    const showDate = spec.showDate !== false; // default show date
    if (!showDate)
        sub.hide();

    const tick = () => {
        const now = GLib.DateTime.new_now_local();
        big.text = now.format(fmt24 ? '%H:%M' : '%I:%M %p');
        if (showDate)
            sub.text = now.format('%a %d %b');
        return GLib.SOURCE_CONTINUE;
    };
    tick();
    const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, tick);

    return {
        actor: box,
        destroy() { if (timer) GLib.source_remove(timer); },
    };
}

// -------------------------------------------------------------------- Script
function makeScript(spec, iconSize, _) {
    const box = card('dock-widget-script');
    const {col, title, sub} = textColumn('…', spec.label || '');
    setFlexWidth(col, spec.width && spec.width > 0 ? spec.width : 180);
    if (!spec.label)
        sub.hide();
    box.add_child(col);

    const interval = Math.max(1, spec.interval || 10);
    let timer = 0;
    let cancel = null;

    const run = () => {
        if (!spec.command) { title.text = ''; return; }
        try {
            const proc = Gio.Subprocess.new(
                ['/bin/sh', '-c', spec.command],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            cancel = new Gio.Cancellable();
            proc.communicate_utf8_async(null, cancel, (p, res) => {
                try {
                    const [, out] = p.communicate_utf8_finish(res);
                    const line = (out || '').trim().split('\n')[0] || '';
                    title.text = line;
                } catch (_e) { /* cancelled or failed */ }
            });
        } catch (_e) {
            title.text = _('error');
        }
    };

    run();
    timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => { run(); return GLib.SOURCE_CONTINUE; });

    return {
        actor: box,
        destroy() {
            if (timer) { GLib.source_remove(timer); timer = 0; }
            if (cancel) { try { cancel.cancel(); } catch (_e) { /* ok */ } }
        },
    };
}
