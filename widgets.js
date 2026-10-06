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
import GdkPixbuf from 'gi://GdkPixbuf';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Calendar from 'resource:///org/gnome/shell/ui/calendar.js';

const CENTER = Clutter.ActorAlign.CENTER;

// Dock background opacity (0..1), kept in sync by the extension so the popups
// (forecast, calendar) match the dock's opacity.
let dockOpacity = 0.65;
export function setDockOpacity(op) {
    if (typeof op === 'number' && op >= 0 && op <= 1)
        dockOpacity = op;
}

// "Vivid colors" option for the dock widgets (weather/system/clock): replaces
// their muted background images with bright, saturated gradients.
let vividWidgets = false;
export function setVividWidgets(b) { vividWidgets = !!b; }

function vividGradient(key) {
    const g = {
        clear:  ['#ffd36b', '#ff7a3d'],   // sunny orange
        partly: ['#7ec8ff', '#3f74ff'],   // blue
        cloudy: ['#9fb4d4', '#4a5f82'],   // steel
        fog:    ['#b9c6d6', '#6b7b90'],   // gray-blue
        rain:   ['#5aa0ff', '#2540c8'],   // deep blue
        snow:   ['#a9ecff', '#49a6ff'],   // icy
        storm:  ['#a06bff', '#5726c0'],   // purple
        clock:  ['#b65bff', '#ff4f9d'],   // purple→pink
        system: ['#2fe0a0', '#10936f'],   // green/teal
    };
    const c = g[key] || g.clear;
    return 'background-gradient-direction: vertical; ' +
        `background-gradient-start: ${c[0]}; background-gradient-end: ${c[1]}; ` +
        'background-image: none;';
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

// mode: 'dock' (compact, default) or 'grid' (rich format for the menu grid).
export function makeWidget(spec, iconSize, _, lang, hooks, mode) {
    if (mode === 'grid')
        return makeWidgetGrid(spec, iconSize, _, lang, hooks);
    switch (spec && spec.type) {
    case 'mpris': return makeMpris(spec, iconSize, _);
    case 'weather': return makeWeather(spec, iconSize, _, lang, hooks);
    case 'system': return makeSystem(spec, iconSize, _);
    case 'clock': return makeClock(spec, iconSize, _);
    case 'script': return makeScript(spec, iconSize, _);
    case 'news': return makeNews(spec, iconSize, _, lang, hooks);
    case 'photos': return makePhotos(spec, iconSize, _);
    case 'chat': return makePlaceholder(_);   // chat is grid-only
    default: return makePlaceholder(_);
    }
}

// Rich widgets for the app-grid (menu) favorites section.
function makeWidgetGrid(spec, iconSize, _, lang, hooks) {
    switch (spec && spec.type) {
    case 'weather': return makeWeatherGrid(spec, _, hooks);
    case 'clock': return makeClockGrid(spec, _);
    case 'news': return makeNewsGrid(spec, _, hooks);
    case 'mpris': return makeMprisGrid(spec, _);
    case 'photos': return makePhotos(spec, iconSize, _, true);
    case 'chat': return makeChatGrid(spec, _, hooks);
    case 'system': return makeSystem(spec, iconSize, _);
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
// Single left-click handler. Fires on button-release (not press) so it does
// NOT trigger while dragging the widget to reorder it: a drag (DND) takes a
// pointer grab and the actor's own 'button-release-event' only arrives on a
// plain click where no drag began.
function onClick(actor, cb) {
    actor.connect('button-release-event', (_a, ev) => {
        let button = 1;
        try { button = ev.get_button(); } catch (_e) { /* keep default */ }
        if (button !== 1)
            return Clutter.EVENT_PROPAGATE;
        cb();
        return Clutter.EVENT_STOP;
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

// Category for an open-meteo WMO weather code.
function wmoCategory(code) {
    const c = Number(code);
    if ([95, 96, 99].includes(c)) return 'storm';
    if ([71, 73, 75, 77, 85, 86].includes(c)) return 'snow';
    if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(c)) return 'rain';
    if ([45, 48].includes(c)) return 'fog';
    if (c === 3) return 'cloudy';
    if ([1, 2].includes(c)) return 'partly';
    return 'clear';
}

function wmoIcon(code) {
    switch (wmoCategory(code)) {
    case 'storm': return 'weather-storm-symbolic';
    case 'snow': return 'weather-snow-symbolic';
    case 'rain': return 'weather-showers-symbolic';
    case 'fog': return 'weather-fog-symbolic';
    case 'cloudy': return 'weather-overcast-symbolic';
    case 'partly': return 'weather-few-clouds-symbolic';
    default: return 'weather-clear-symbolic';
    }
}

function wmoText(code, _) {
    switch (wmoCategory(code)) {
    case 'storm': return _('Tormenta');
    case 'snow': return _('Nieve');
    case 'rain': return _('Lluvia');
    case 'fog': return _('Niebla');
    case 'cloudy': return _('Nublado');
    case 'partly': return _('Parcialmente nublado');
    default: return _('Despejado');
    }
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

function parseIso(s) {
    const [d, t] = String(s).split('T');
    const [y, mo, da] = d.split('-').map(Number);
    const [h, mi] = (t || '0:0').split(':').map(Number);
    return GLib.DateTime.new_local(y, mo, da, h, mi || 0, 0);
}

// Builds the rich weather view (current + hourly + 5-day) as a reusable actor.
// Returns {container, update(lat, lon)}; `update` fetches open-meteo and fills
// it in. Used both by the popup (openForecast) and by the grid weather widget.
function forecastView(name, _, hooks, spec, width) {
    const now = GLib.DateTime.new_now_local();
    const rawCache = hooks && spec && spec.id ? hooks.getCache(spec.id) : null;
    const cache = rawCache && typeof rawCache === 'object' ? rawCache : {};
    const fc = cache.fc || null;   // last shown forecast (from memory)

    const container = new St.BoxLayout({style_class: 'dock-forecast', vertical: true});
    container.set_width(width);

    // ---- Current conditions header ----
    const head = new St.BoxLayout({style_class: 'dock-fc-head', vertical: true});
    const locRow = new St.BoxLayout({style_class: 'dock-fc-loc'});
    locRow.add_child(new St.Icon({icon_name: 'find-location-symbolic', icon_size: 14}));
    locRow.add_child(new St.Label({style_class: 'dock-fc-loc-label', text: name || cache.title || _('Clima')}));
    head.add_child(locRow);

    const bigRow = new St.BoxLayout({style_class: 'dock-fc-bigrow'});
    const bigTemp = new St.Label({style_class: 'dock-fc-big', text: (fc && fc.cur && fc.cur.temp) || '…', y_align: CENTER});
    const condBox = new St.BoxLayout({vertical: true, x_expand: true, x_align: Clutter.ActorAlign.END, y_align: CENTER});
    const condIcon = new St.Icon({style_class: 'dock-fc-cond-icon', icon_name: (fc && fc.cur && fc.cur.icon) || 'weather-clear-symbolic', icon_size: 34, x_align: Clutter.ActorAlign.END});
    const condLabel = new St.Label({style_class: 'dock-fc-cond', text: (fc && fc.cur && fc.cur.cond) || '', x_align: Clutter.ActorAlign.END});
    condBox.add_child(condIcon);
    condBox.add_child(condLabel);
    bigRow.add_child(bigTemp);
    bigRow.add_child(condBox);
    head.add_child(bigRow);

    const details = new St.BoxLayout({style_class: 'dock-fc-details'});
    const mkDetail = (icon, val) => {
        const b = new St.BoxLayout({style_class: 'dock-fc-detail', x_expand: true});
        b.add_child(new St.Icon({icon_name: icon, icon_size: 13}));
        const l = new St.Label({style_class: 'dock-fc-detail-label', text: val || '—', y_align: CENTER});
        b.add_child(l);
        details.add_child(b);
        return l;
    };
    const windL = mkDetail('weather-windy-symbolic', fc && fc.cur && fc.cur.wind);
    const pressL = mkDetail('daytime-sunset-symbolic', fc && fc.cur && fc.cur.press);
    const humL = mkDetail('weather-showers-scattered-symbolic', fc && fc.cur && fc.cur.hum);
    head.add_child(details);
    container.add_child(head);

    // ---- Hourly (now +0/+3/+6/+9h) ----
    const hoursBox = new St.BoxLayout({style_class: 'dock-fc-hours'});
    const hourRefs = [];
    const offsets = [0, 3, 6, 9];
    offsets.forEach((off, k) => {
        const cell = new St.BoxLayout({style_class: 'dock-fc-hour', vertical: true, x_expand: true});
        const ht = new St.Label({style_class: 'dock-fc-htime', text: now.add_hours(off).format('%H:00'), x_align: CENTER});
        const chc = fc && fc.hours && fc.hours[k];
        const hi = new St.Icon({icon_name: (chc && chc.icon) || 'weather-clear-symbolic', icon_size: 18, x_align: CENTER});
        const hp = new St.Label({style_class: 'dock-fc-htemp', text: (chc && chc.temp) || '…', x_align: CENTER});
        cell.add_child(ht);
        cell.add_child(hi);
        cell.add_child(hp);
        hoursBox.add_child(cell);
        hourRefs.push({hi, hp});
    });
    container.add_child(hoursBox);

    // ---- Daily (5 days) ----
    const daysBox = new St.BoxLayout({style_class: 'dock-fc-days', vertical: true});
    const dayRefs = [];
    for (let i = 0; i < 5; i++) {
        const dt = now.add_days(i);
        const cd = fc && fc.days && fc.days[i];
        const row = new St.BoxLayout({style_class: 'dock-fc-drow'});
        const dn = new St.Label({
            style_class: 'dock-fc-dname',
            text: i === 0 ? _('Hoy') : dt.format('%a %d %b'),
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: CENTER,
        });
        const di = new St.Icon({style_class: 'dock-forecast-icon', icon_name: (cd && cd.icon) || 'weather-clear-symbolic', icon_size: 20});
        const dmax = new St.Label({style_class: 'dock-fc-dmax', text: (cd && cd.max) || '…', y_align: CENTER});
        const dmin = new St.Label({style_class: 'dock-fc-dmin', text: (cd && cd.min) || '', y_align: CENTER});
        row.add_child(dn);
        row.add_child(di);
        row.add_child(dmax);
        row.add_child(dmin);
        daysBox.add_child(row);
        dayRefs.push({di, dmax, dmin});
    }
    container.add_child(daysBox);

    const update = (lat, lon) => {
        if (lat == null || lon == null) {
            if (!fc)
                bigTemp.text = _('sin datos');
            return;
        }
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
            '&current=temperature_2m,weather_code,wind_speed_10m,surface_pressure,relative_humidity_2m' +
            '&hourly=temperature_2m,weather_code' +
            '&daily=weather_code,temperature_2m_max,temperature_2m_min&forecast_days=5&timezone=auto';
        const session = new Soup.Session();
        container._fcSession = session;
        let msg;
        try {
            msg = Soup.Message.new('GET', url);
        } catch (_e) {
            return;
        }
        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
            try {
                const bytes = session.send_and_read_finish(res);
                const data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                const cur = data.current;
                const fcNew = {cur: {}, hours: [], days: []};
                fcNew.cur.temp = `${Math.round(cur.temperature_2m)}°`;
                fcNew.cur.icon = wmoIcon(cur.weather_code);
                fcNew.cur.cond = wmoText(cur.weather_code, _);
                fcNew.cur.wind = `${Math.round(cur.wind_speed_10m)} km/h`;
                fcNew.cur.press = `${Math.round(cur.surface_pressure)} hPa`;
                fcNew.cur.hum = `${Math.round(cur.relative_humidity_2m)} %`;
                bigTemp.text = fcNew.cur.temp;
                condIcon.icon_name = fcNew.cur.icon;
                condLabel.text = fcNew.cur.cond;
                windL.text = fcNew.cur.wind;
                pressL.text = fcNew.cur.press;
                humL.text = fcNew.cur.hum;

                const h = data.hourly;
                const nowKey = now.format('%Y-%m-%dT%H:00');
                let idx = h.time.indexOf(nowKey);
                if (idx < 0)
                    idx = h.time.findIndex(t => t >= nowKey);
                if (idx < 0)
                    idx = 0;
                for (let k = 0; k < hourRefs.length; k++) {
                    const j = idx + offsets[k];
                    if (j < h.time.length) {
                        const ic = wmoIcon(h.weather_code[j]);
                        const tp = `${Math.round(h.temperature_2m[j])}°`;
                        hourRefs[k].hi.icon_name = ic;
                        hourRefs[k].hp.text = tp;
                        fcNew.hours[k] = {icon: ic, temp: tp};
                    }
                }

                const d = data.daily;
                for (let i = 0; i < dayRefs.length && i < d.time.length; i++) {
                    const ic = wmoIcon(d.weather_code[i]);
                    const mx = `${Math.round(d.temperature_2m_max[i])}°`;
                    const mn = `${Math.round(d.temperature_2m_min[i])}°`;
                    dayRefs[i].di.icon_name = ic;
                    dayRefs[i].dmax.text = mx;
                    dayRefs[i].dmin.text = mn;
                    fcNew.days[i] = {icon: ic, max: mx, min: mn};
                }

                if (hooks && spec && spec.id)
                    hooks.setCache(spec.id, {fc: fcNew});
            } catch (_e) {
                // Keep whatever is shown (cached); don't clear on error.
            }
        });
    };

    container.connect('destroy', () => {
        try { if (container._fcSession) container._fcSession.abort(); } catch (_e) { /* ok */ }
    });

    return {container, update, bigTemp};
}

// Rich weather popup (current + hourly + 5-day) shown next to the widget.
function openForecast(sourceActor, lat, lon, name, _, hooks, spec) {
    const panelW = Math.max(sourceActor && sourceActor.width ? sourceActor.width : 0, 270);
    const v = forecastView(name, _, hooks, spec, panelW);
    showPopup(v.container, sourceActor);
    v.update(lat, lon);
}

// Resolves a location to {lat, lon, title} via wttr.in (same source the compact
// weather widget uses), caching the result for the forecast.
function resolveWeatherCoords(spec, hooks, cb) {
    const loc = (spec.location || '').trim();
    const base = loc ? `https://wttr.in/${encodeURIComponent(loc)}` : 'https://wttr.in/';
    const session = new Soup.Session();
    let msg;
    try {
        msg = Soup.Message.new('GET', `${base}?format=j1`);
    } catch (_e) {
        cb(null);
        return;
    }
    session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
        try {
            const bytes = session.send_and_read_finish(res);
            const data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
            const na = data.nearest_area && data.nearest_area[0];
            if (!na) { cb(null); return; }
            const lat = na.latitude, lon = na.longitude;
            const title = loc ? loc.split(',')[0].trim() : na.areaName[0].value;
            if (hooks && spec.id)
                hooks.setCache(spec.id, {lat, lon, title});
            cb({lat, lon, title});
        } catch (_e) {
            cb(null);
        }
    });
}

// Grid weather widget: the 5-day forecast card embedded in the app grid.
function makeWeatherGrid(spec, _, hooks) {
    const rawCache = hooks && spec.id ? hooks.getCache(spec.id) : null;
    const cache = rawCache && typeof rawCache === 'object' ? rawCache : {};
    const loc = (spec.location || '').trim();
    const name = loc ? loc.split(',')[0].trim() : (cache.title || _('Clima'));
    const v = forecastView(name, _, hooks, spec, 300);
    if (cache.lat != null && cache.lon != null) {
        v.update(cache.lat, cache.lon);
    } else {
        resolveWeatherCoords(spec, hooks, (c) => {
            if (c && v.container.get_stage())
                v.update(c.lat, c.lon);
        });
    }
    return {actor: v.container, destroy() { /* session aborts on actor destroy */ }};
}

// Builds the month calendar (with GNOME Online Accounts events) as a reusable
// actor. It cleans up its event source on 'destroy'. Used by the popup
// (openCalendar) and embedded in the grid clock widget.
function buildCalendar() {
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

    // Events of the selected day (from GNOME Online Accounts / calendars).
    const eventsBox = new St.BoxLayout({style_class: 'dock-calendar-events', vertical: true});
    container.add_child(eventsBox);

    // Event source: aggregates the calendars connected in GNOME (Google,
    // Microsoft, CalDAV/iCloud…). Degrades gracefully if unavailable.
    let source = null;
    try {
        source = new Calendar.DBusEventSource();
    } catch (_e) {
        source = null;
    }

    const eventsOn = (day) => {
        if (!source)
            return [];
        try {
            const b = new Date(viewY, viewM - 1, day, 0, 0, 0);
            const e = new Date(viewY, viewM - 1, day, 23, 59, 59);
            return source.getEvents(b, e) || [];
        } catch (_e) {
            return [];
        }
    };

    const pad2 = (n) => (n < 10 ? '0' + n : '' + n);
    let selectedDay = (viewY === todayY && viewM === todayM) ? todayD : 1;
    const dayButtons = {};

    const showDayEvents = (day) => {
        eventsBox.destroy_all_children();
        const evs = eventsOn(day).slice().sort((a, b) => a.date - b.date);
        if (evs.length === 0) {
            eventsBox.add_child(new St.Label({style_class: 'dock-calendar-noevents', text: _('Sin eventos')}));
            return;
        }
        for (const ev of evs.slice(0, 6)) {
            const r = new St.BoxLayout({style_class: 'dock-calendar-event'});
            const when = ev.allDay
                ? _('Todo el día')
                : `${pad2(ev.date.getHours())}:${pad2(ev.date.getMinutes())}`;
            r.add_child(new St.Label({style_class: 'dock-calendar-event-time', text: when}));
            const t = new St.Label({
                style_class: 'dock-calendar-event-title',
                text: ev.summary || _('(sin título)'),
                x_expand: true,
            });
            t.clutter_text.set_ellipsize(3);
            r.add_child(t);
            eventsBox.add_child(r);
        }
    };

    const selectDay = (day) => {
        if (dayButtons[selectedDay])
            dayButtons[selectedDay].remove_style_class_name('selected');
        selectedDay = day;
        if (dayButtons[day])
            dayButtons[day].add_style_class_name('selected');
        showDayEvents(day);
    };

    const render = () => {
        grid.destroy_all_children();
        for (const k of Object.keys(dayButtons))
            delete dayButtons[k];
        const first = GLib.DateTime.new_local(viewY, viewM, 1, 12, 0, 0);
        titleL.text = first.format('%B %Y');
        // Weekday headers (Monday-first; 2024-01-01 was a Monday).
        for (let i = 0; i < 7; i++) {
            const d = GLib.DateTime.new_local(2024, 1, 1 + i, 12, 0, 0);
            gl.attach(new St.Label({
                style_class: 'dock-calendar-wd',
                text: d.format('%a'),
                x_expand: true,
                x_align: CENTER,
            }), i, 0, 1, 1);
        }
        // Ask the source to load this month's events.
        if (source) {
            try {
                source.requestRange(
                    new Date(viewY, viewM - 1, 1, 0, 0, 0),
                    new Date(viewY, viewM - 1, first.add_months(1).add_days(-1).get_day_of_month(), 23, 59, 59));
            } catch (_e) { /* ignore */ }
        }
        const startDow = first.get_day_of_week();   // 1=Mon .. 7=Sun
        const daysInMonth = first.add_months(1).add_days(-1).get_day_of_month();
        let col = startDow - 1;
        let row = 1;
        for (let day = 1; day <= daysInMonth; day++) {
            const cell = new St.Button({
                style_class: 'dock-calendar-day',
                label: String(day),
                x_expand: true,
                can_focus: true,
            });
            if (viewY === todayY && viewM === todayM && day === todayD)
                cell.add_style_class_name('today');
            if (eventsOn(day).length > 0)
                cell.add_style_class_name('has-event');
            if (day === selectedDay)
                cell.add_style_class_name('selected');
            cell.connect('clicked', () => selectDay(day));
            gl.attach(cell, col, row, 1, 1);
            dayButtons[day] = cell;
            col++;
            if (col > 6) { col = 0; row++; }
        }
        showDayEvents(selectedDay);
    };

    prev.connect('clicked', () => {
        viewM--;
        if (viewM < 1) { viewM = 12; viewY--; }
        selectedDay = 1;
        render();
    });
    next.connect('clicked', () => {
        viewM++;
        if (viewM > 12) { viewM = 1; viewY++; }
        selectedDay = 1;
        render();
    });

    // Re-render when the calendars finish loading / change.
    let changedId = 0;
    if (source) {
        try {
            changedId = source.connect('changed', () => render());
        } catch (_e) { /* ignore */ }
    }
    container.connect('destroy', () => {
        if (source) {
            try { if (changedId) source.disconnect(changedId); } catch (_e) { /* ok */ }
            try { source.destroy(); } catch (_e) { /* ok */ }
        }
    });

    render();
    return container;
}

// Month calendar popup (click on the clock widget in the dock).
function openCalendar(sourceActor) {
    showPopup(buildCalendar(), sourceActor);
}

// Grid clock widget: big ticking time + date, with the month calendar below.
function makeClockGrid(spec, _) {
    const container = new St.BoxLayout({style_class: 'dock-clock-grid', vertical: true});
    const timeL = new St.Label({style_class: 'dock-clock-grid-time', x_align: CENTER});
    const dateL = new St.Label({style_class: 'dock-clock-grid-date', x_align: CENTER});
    container.add_child(timeL);
    container.add_child(dateL);

    const fmt24 = spec.format24 !== false;
    const tick = () => {
        const now = GLib.DateTime.new_now_local();
        timeL.text = now.format(fmt24 ? '%H:%M:%S' : '%I:%M:%S %p');
        dateL.text = now.format('%A, %d %B %Y');
        return GLib.SOURCE_CONTINUE;
    };
    tick();
    const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, tick);

    container.add_child(buildCalendar());   // month view (self-cleans on destroy)

    return {
        actor: container,
        destroy() { if (timer) GLib.source_remove(timer); },
    };
}

function makeWeather(spec, iconSize, _, lang, hooks) {
    const box = card('dock-widget-weather');
    const icon = new St.Icon({
        style_class: 'dock-widget-art',
        icon_name: 'weather-clear-symbolic',
        icon_size: iconSize,
    });
    const loc = (spec.location || '').trim();
    // Friendly label for a MANUAL location: the part before the first comma,
    // e.g. "Santiago, Chile" → "Santiago". Empty when the location is automatic
    // (by IP). We show this instead of wttr.in's resolved "nearest area" name
    // (which for Santiago can be a sector like "Lo Valdivieso").
    const manualLabel = loc ? loc.split(',')[0].trim() : '';
    // Must be an object; older versions stored a bare string here, which would
    // make e.g. cache.sub resolve to String.prototype.sub (a function).
    const rawCache = hooks && spec.id ? hooks.getCache(spec.id) : null;
    const cache = rawCache && typeof rawCache === 'object' ? rawCache : {};
    const {col, title, sub} = textColumn(manualLabel || _('Clima'), '…');
    // FIXED width (75% of the previous base of 150), so the widget's size never
    // changes with the content — the text ellipsizes instead.
    col.set_width(Math.round(150 * 0.75));
    box.add_child(icon);
    box.add_child(col);

    // Single click → 5-day forecast. Coordinates come from the last fetch or
    // from the cache (so it works right after login too).
    let lat = cache.lat != null ? cache.lat : null;
    let lon = cache.lon != null ? cache.lon : null;
    onClick(box, () => openForecast(box, lat, lon, title.text, _, hooks, spec));

    if (vividWidgets)
        box.add_style_class_name('vivid');
    // In vivid mode use a bright gradient (by condition) instead of the image.
    const setBg = (uri) => {
        if (vividWidgets)
            return;
        box.set_style(
            `background-image: url("${uri}"); background-size: cover; background-position: center;`);
    };

    // Initial state from the cache (last shown), so a rebuild/relaunch keeps the
    // previous look and text instead of flashing/clearing. Sunny only the very
    // first time ever.
    const soleado = dataUri('soleado.png');
    let lastBg = cache.bg || soleado;
    setBg(lastBg);
    if (vividWidgets)
        box.set_style(vividGradient(cache.cat || 'clear'));
    // For a manual location keep the user's label; only trust the cached title
    // when the location is automatic (so a stale resolved name doesn't stick).
    if (manualLabel)
        title.text = manualLabel;
    else if (cache.title)
        title.text = cache.title;
    if (cache.sub)
        sub.text = cache.sub;
    if (cache.icon)
        icon.icon_name = cache.icon;

    // wttr.in returns the description in English by default; request it in the
    // extension's language and read the translated `lang_<code>` field.
    const langCode = lang && lang !== 'en' ? lang : '';

    const session = new Soup.Session();
    let timer = 0;

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
            return; // keep the last shown info
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
                const subText = `${cur.temp_C}°C · ${desc}`;
                const iconName = weatherIcon(cur.weatherCode);
                sub.text = subText;
                icon.icon_name = iconName;
                let titleText = manualLabel || title.text;
                if (data.nearest_area && data.nearest_area[0]) {
                    const na = data.nearest_area[0];
                    // Use wttr.in's resolved area name ONLY for automatic (IP)
                    // location; with a manual location keep the user's label.
                    if (!manualLabel)
                        titleText = na.areaName[0].value;
                    lat = na.latitude;
                    lon = na.longitude;
                }
                title.text = titleText;
                // Condition background image; only re-apply on change (no flicker).
                const bg = weatherBgUri(cur.weatherCode);
                if (bg !== lastBg) {
                    lastBg = bg;
                    setBg(bg);
                }
                const cat = weatherCategory(cur.weatherCode);
                if (vividWidgets)
                    box.set_style(vividGradient(cat));
                // Persist the last shown snapshot.
                if (hooks && spec.id) {
                    hooks.setCache(spec.id, {
                        bg, cat, title: titleText, sub: subText, icon: iconName, lat, lon,
                    });
                }
            } catch (_e) {
                // Network/parse error: keep the last shown info (don't clear).
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
    if (vividWidgets) {
        box.add_style_class_name('vivid');
        box.set_style(vividGradient('system'));
    } else {
        setCardBg(box, 'sistemas.png');
    }
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
    if (vividWidgets) {
        box.add_style_class_name('vivid');
        box.set_style(vividGradient('clock'));
    } else {
        setCardBg(box, 'reloj.png');
    }
    const info = new St.BoxLayout({style_class: 'dock-widget-text', vertical: true, y_align: CENTER});
    const big = new St.Label({style_class: 'dock-widget-time'});
    const sub = new St.Label({style_class: 'dock-widget-sub'});
    info.add_child(big);
    info.add_child(sub);
    box.add_child(info);

    // Single click → open our own month calendar (above the clock widget).
    onClick(box, () => openCalendar(box));

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

// --------------------------------------------------------------------- News
// Country → Google News RSS parameters (hl = interface language, gl = country,
// ceid = country:lang). No API key needed; the feed is public RSS/XML.
const NEWS_COUNTRIES = {
    CL: {hl: 'es-419', gl: 'CL', lang: 'es',     name: 'Chile'},
    AR: {hl: 'es-419', gl: 'AR', lang: 'es',     name: 'Argentina'},
    MX: {hl: 'es-419', gl: 'MX', lang: 'es',     name: 'México'},
    PE: {hl: 'es-419', gl: 'PE', lang: 'es',     name: 'Perú'},
    CO: {hl: 'es-419', gl: 'CO', lang: 'es',     name: 'Colombia'},
    ES: {hl: 'es',     gl: 'ES', lang: 'es',     name: 'España'},
    US: {hl: 'en-US',  gl: 'US', lang: 'en',     name: 'Estados Unidos'},
    GB: {hl: 'en-GB',  gl: 'GB', lang: 'en',     name: 'Reino Unido'},
    BR: {hl: 'pt-BR',  gl: 'BR', lang: 'pt-419', name: 'Brasil'},
    FR: {hl: 'fr',     gl: 'FR', lang: 'fr',     name: 'Francia'},
    DE: {hl: 'de',     gl: 'DE', lang: 'de',     name: 'Alemania'},
    IT: {hl: 'it',     gl: 'IT', lang: 'it',     name: 'Italia'},
};

// Decodes XML/HTML entities and strips CDATA wrappers from RSS text.
function decodeEntities(s) {
    if (!s)
        return '';
    return String(s)
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/<[^>]+>/g, '')            // drop stray inline tags
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#0*39;/g, "'").replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_m, n) => { try { return String.fromCharCode(Number(n)); } catch (_e) { return ''; } })
        .replace(/&amp;/g, '&');            // must be last
}

// Extracts up to `max` {title, link, source, date} items from an RSS feed.
function parseRssItems(xml, max) {
    const items = [];
    const re = /<item\b[^>]*>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = re.exec(xml)) && items.length < (max || 20)) {
        const block = m[1];
        const tm = block.match(/<title>([\s\S]*?)<\/title>/);
        const lm = block.match(/<link>([\s\S]*?)<\/link>/);
        const sm = block.match(/<source[^>]*>([\s\S]*?)<\/source>/);
        const pm = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
        let title = decodeEntities(tm ? tm[1] : '').trim();
        const link = decodeEntities(lm ? lm[1] : '').trim();
        const source = decodeEntities(sm ? sm[1] : '').trim();
        const date = pm ? pm[1].trim() : '';
        // Google News titles are "Headline - Source"; drop the trailing source.
        if (source && title.endsWith(` - ${source}`))
            title = title.slice(0, -(source.length + 3)).trim();
        if (title)
            items.push({title, link, source, date});
    }
    return items;
}

// Short relative age ("3 h", "2 d") from an RSS pubDate string.
function relativeAge(dateStr, _) {
    if (!dateStr)
        return '';
    const t = Date.parse(dateStr);
    if (isNaN(t))
        return '';
    const mins = Math.max(0, Math.floor((Date.now() - t) / 60000));
    if (mins < 60)
        return `${mins} min`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)
        return `${hrs} h`;
    return `${Math.floor(hrs / 24)} d`;
}

function makeNews(spec, iconSize, _, lang, hooks) {
    const box = card('dock-widget-news');
    const icon = new St.Icon({
        style_class: 'dock-widget-art',
        icon_name: 'application-rss+xml-symbolic',
        icon_size: iconSize,
    });
    // Headline on top (rotating), "Noticias · <country>" below.
    const {col, title, sub} = textColumn('…', _('Noticias'));
    col.set_width(Math.round(150 * 1.1));   // a touch wider for headlines
    box.add_child(icon);
    box.add_child(col);

    const code = (spec.country || 'CL').toUpperCase();
    const c = NEWS_COUNTRIES[code] || NEWS_COUNTRIES.CL;
    const url = `https://news.google.com/rss?hl=${c.hl}&gl=${c.gl}&ceid=${c.gl}:${c.lang}`;
    sub.text = `${_('Noticias')} · ${c.name}`;

    const rawCache = hooks && spec.id ? hooks.getCache(spec.id) : null;
    const cache = rawCache && typeof rawCache === 'object' ? rawCache : {};
    // Only reuse cached headlines if they are for the same country.
    let items = (cache.country === code && Array.isArray(cache.items)) ? cache.items : [];

    let idx = 0;
    const showCurrent = () => {
        title.text = items.length ? items[idx % items.length].title : _('Cargando…');
    };
    showCurrent();

    // Single click → popup list of headlines (read `items` at click time).
    onClick(box, () => openNews(box, items, _));

    const session = new Soup.Session();
    const fetch = () => {
        let msg;
        try {
            msg = Soup.Message.new('GET', url);
        } catch (_e) {
            return; // keep the last shown headlines
        }
        try { msg.request_headers.append('User-Agent', 'Mozilla/5.0'); } catch (_e) { /* ok */ }
        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
            try {
                const bytes = session.send_and_read_finish(res);
                const xml = new TextDecoder().decode(bytes.get_data());
                const parsed = parseRssItems(xml, 20);
                if (parsed.length) {
                    items = parsed;
                    idx = 0;
                    showCurrent();
                    if (hooks && spec.id)
                        hooks.setCache(spec.id, {items, country: code});
                }
            } catch (_e) {
                // Network/parse error: keep the last shown headlines (no clear).
            }
        });
    };
    fetch();

    // Refresh headlines every 15 min; rotate the shown one every 9 s.
    const refreshTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 900,
        () => { fetch(); return GLib.SOURCE_CONTINUE; });
    const rotateTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 9, () => {
        if (items.length) { idx = (idx + 1) % items.length; showCurrent(); }
        return GLib.SOURCE_CONTINUE;
    });

    return {
        actor: box,
        destroy() {
            if (refreshTimer) GLib.source_remove(refreshTimer);
            if (rotateTimer) GLib.source_remove(rotateTimer);
            try { session.abort(); } catch (_e) { /* ok */ }
        },
    };
}

// Popup with the list of headlines; each opens the article in the browser.
function openNews(sourceActor, items, _) {
    const container = new St.BoxLayout({style_class: 'dock-news', vertical: true});
    const base = sourceActor && sourceActor.width ? sourceActor.width : 0;
    container.set_width(Math.min(460, Math.max(340, base * 2)));

    container.add_child(new St.Label({style_class: 'dock-news-header', text: _('Noticias')}));

    let popup = null;
    if (!items || !items.length) {
        container.add_child(new St.Label({
            style_class: 'dock-news-empty', text: _('Sin titulares por ahora'),
        }));
    } else {
        const scroll = new St.ScrollView({style_class: 'dock-news-scroll'});
        scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        const list = new St.BoxLayout({vertical: true});
        scroll.set_child(list);
        const max = Math.min(items.length, 15);
        for (let i = 0; i < max; i++) {
            const it = items[i];
            const btn = new St.Button({style_class: 'dock-news-item', x_expand: true});
            const lbl = new St.Label({text: it.title});
            lbl.clutter_text.set_line_wrap(true);
            btn.set_child(lbl);
            btn.connect('clicked', () => {
                if (it.link) {
                    try { Gio.AppInfo.launch_default_for_uri(it.link, null); } catch (_e) { /* ok */ }
                }
                if (popup) popup.close();
            });
            list.add_child(btn);
        }
        container.add_child(scroll);
    }
    popup = showPopup(container, sourceActor);
    return popup;
}

// --------------------------------------------------------------------- Photos
// A Polaroid-style slideshow of the user's local photos.
const PHOTO_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'jfif', 'avif'];

function picturesDir() {
    try {
        const d = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES);
        if (d) return d;
    } catch (_e) { /* ignore */ }
    const home = GLib.get_home_dir();
    for (const n of ['Imágenes', 'Pictures', 'Imagenes', 'Fotos']) {
        const p = GLib.build_filenamev([home, n]);
        if (GLib.file_test(p, GLib.FileTest.IS_DIR))
            return p;
    }
    return home;
}

// Lists image files under `dir` (up to depth 2), capped at `cap` entries.
function listImages(dir, cap) {
    const out = [];
    const walk = (path, depth) => {
        if (out.length >= cap || depth > 2)
            return;
        let en;
        try {
            en = Gio.File.new_for_path(path).enumerate_children(
                'standard::name,standard::type,standard::is-hidden',
                Gio.FileQueryInfoFlags.NONE, null);
        } catch (_e) {
            return;
        }
        let info;
        while ((info = en.next_file(null)) !== null) {
            if (out.length >= cap)
                break;
            if (info.get_is_hidden())
                continue;
            const name = info.get_name();
            const child = GLib.build_filenamev([path, name]);
            if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                walk(child, depth + 1);
            } else {
                const dot = name.lastIndexOf('.');
                const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
                if (PHOTO_EXTS.includes(ext))
                    out.push(child);
            }
        }
        try { en.close(null); } catch (_e) { /* ok */ }
    };
    walk(dir, 0);
    return out;
}

function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function photoName(p) {
    const b = GLib.path_get_basename(p);
    const dot = b.lastIndexOf('.');
    return dot > 0 ? b.slice(0, dot) : b;
}

function makePhotos(spec, iconSize, _, big) {
    const box = new St.BoxLayout({
        style_class: 'dock-widget dock-widget-photos' + (big ? ' dock-widget-photos-big' : ''),
        reactive: true,
        vertical: true,
        y_align: CENTER,
    });
    const ph = big ? 200 : Math.max(40, Math.round(iconSize * 0.9));
    const pw = big ? 270 : Math.round(ph * 1.35);
    const photo = new St.Widget({style_class: 'dock-photo-img'});
    photo.set_size(pw, ph);
    box.add_child(photo);
    const cap = new St.Label({style_class: 'dock-photo-cap'});
    cap.clutter_text.set_ellipsize(3 /* END */);
    cap.set_style(`max-width: ${pw + 8}px;`);
    box.add_child(cap);

    const dir = (spec.folder && spec.folder.trim()) ? spec.folder.trim() : picturesDir();
    let images = shuffle(listImages(dir, 400));
    let idx = 0;

    const show = () => {
        if (!images.length) { cap.text = _('Sin fotos'); return; }
        const p = images[idx % images.length];
        photo.set_style(
            `background-image: url("${Gio.File.new_for_path(p).get_uri()}"); ` +
            'background-size: cover; background-position: center;');
        cap.text = photoName(p);
    };
    show();

    onClick(box, () => {
        if (images.length)
            openPhotos(box, images, idx % images.length, _);
    });

    const interval = Math.max(2, spec.interval || 8);
    const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
        if (images.length) { idx = (idx + 1) % images.length; show(); }
        return GLib.SOURCE_CONTINUE;
    });
    // Rescan occasionally so newly added photos show up.
    const rescan = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 600, () => {
        const fresh = listImages(dir, 400);
        if (fresh.length) { images = shuffle(fresh); idx = 0; show(); }
        return GLib.SOURCE_CONTINUE;
    });

    return {
        actor: box,
        destroy() {
            if (timer) GLib.source_remove(timer);
            if (rescan) GLib.source_remove(rescan);
        },
    };
}

// Larger Polaroid popup with prev/next; clicking the photo opens it in the
// default image viewer.
function openPhotos(sourceActor, images, startIdx, _) {
    let idx = startIdx || 0;
    const wrap = (i) => ((i % images.length) + images.length) % images.length;

    const container = new St.BoxLayout({style_class: 'dock-photos-popup', vertical: true});

    const frame = new St.BoxLayout({style_class: 'dock-photos-frame', vertical: true});
    const big = new St.Widget({style_class: 'dock-photos-big'});
    big.set_size(360, 260);
    frame.add_child(big);
    const bigCap = new St.Label({style_class: 'dock-photos-bigcap'});
    bigCap.clutter_text.set_ellipsize(3);
    frame.add_child(bigCap);
    const frameBtn = new St.Button({style_class: 'dock-photos-framebtn', child: frame});
    container.add_child(frameBtn);

    const nav = new St.BoxLayout({style_class: 'dock-photos-nav'});
    const prev = new St.Button({
        style_class: 'dock-photos-navbtn',
        child: new St.Icon({icon_name: 'go-previous-symbolic', icon_size: 18}),
    });
    const spacer = new St.Widget({x_expand: true});
    const openBtn = new St.Button({
        style_class: 'dock-photos-navbtn',
        child: new St.Icon({icon_name: 'image-x-generic-symbolic', icon_size: 18}),
    });
    const next = new St.Button({
        style_class: 'dock-photos-navbtn',
        child: new St.Icon({icon_name: 'go-next-symbolic', icon_size: 18}),
    });
    nav.add_child(prev);
    nav.add_child(spacer);
    nav.add_child(openBtn);
    nav.add_child(next);
    container.add_child(nav);

    const render = () => {
        const p = images[wrap(idx)];
        big.set_style(
            `background-image: url("${Gio.File.new_for_path(p).get_uri()}"); ` +
            'background-size: cover; background-position: center;');
        bigCap.text = GLib.path_get_basename(p);
    };
    const openCurrent = () => {
        try {
            Gio.AppInfo.launch_default_for_uri(
                Gio.File.new_for_path(images[wrap(idx)]).get_uri(), null);
        } catch (_e) { /* ok */ }
    };
    prev.connect('clicked', () => { idx = wrap(idx - 1); render(); });
    next.connect('clicked', () => { idx = wrap(idx + 1); render(); });
    frameBtn.connect('clicked', openCurrent);
    openBtn.connect('clicked', openCurrent);
    render();

    return showPopup(container, sourceActor);
}

// ---------------------------------------------------------- Grid: news feed
// Primary source: GDELT DOC API (public, no key) which returns per-article
// images (socialimage) and supports country/language filters. Falls back to
// Google News RSS (text only) if GDELT returns nothing. Images are downloaded
// once and cached on disk.
const NEWS_GDELT = {
    CL: {cc: 'CI', lang: 'spanish'},    AR: {cc: 'AR', lang: 'spanish'},
    MX: {cc: 'MX', lang: 'spanish'},    PE: {cc: 'PE', lang: 'spanish'},
    CO: {cc: 'CO', lang: 'spanish'},    ES: {cc: 'SP', lang: 'spanish'},
    US: {cc: 'US', lang: 'english'},    GB: {cc: 'UK', lang: 'english'},
    BR: {cc: 'BR', lang: 'portuguese'}, FR: {cc: 'FR', lang: 'french'},
    DE: {cc: 'GM', lang: 'german'},     IT: {cc: 'IT', lang: 'italian'},
};

function newsCacheDir() {
    const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'dock-stack', 'news']);
    try { GLib.mkdir_with_parents(dir, 0o755); } catch (_e) { /* ok */ }
    return dir;
}

function newsImageBase(url) {
    const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, url, -1);
    return GLib.build_filenamev([newsCacheDir(), hash]);
}

// Picks a file extension from the raw image bytes (St/GdkPixbuf is happier when
// the cached file has a real image extension).
function sniffImageExt(b) {
    if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50) return '.png';
    if (b.length > 3 && b[0] === 0xFF && b[1] === 0xD8) return '.jpg';
    if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return '.gif';
    if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return '.webp';
    if (b.length > 2 && b[0] === 0x42 && b[1] === 0x4D) return '.bmp';
    return '.jpg';
}

function existingNewsImage(base) {
    for (const e of ['.jpg', '.png', '.webp', '.gif', '.bmp']) {
        const p = base + e;
        if (GLib.file_test(p, GLib.FileTest.EXISTS))
            return p;
    }
    return null;
}

// Center-crops `srcPath` to a square of `size`px (cached). Returns the dest
// path or null. Using a pre-cropped square means St.Icon (contain) fills it
// with no letterboxing.
function makeSquareThumb(srcPath, size) {
    const dest = `${srcPath}.sq${size}.png`;
    if (GLib.file_test(dest, GLib.FileTest.EXISTS))
        return dest;
    try {
        const pb = GdkPixbuf.Pixbuf.new_from_file(srcPath);
        const w = pb.get_width(), h = pb.get_height();
        const s = Math.min(w, h);
        const sub = pb.new_subpixbuf(Math.floor((w - s) / 2), Math.floor((h - s) / 2), s, s);
        const scaled = sub.scale_simple(size, size, GdkPixbuf.InterpType.BILINEAR);
        scaled.savev(dest, 'png', [], []);
        return dest;
    } catch (_e) {
        return null;
    }
}

// Paints a cached square thumbnail onto an St.Icon the SAME way the music
// widget shows album art (Gio.FileIcon) — a rendering path proven to work.
function applyThumb(iconActor, path) {
    try {
        iconActor.gicon = new Gio.FileIcon({file: Gio.File.new_for_path(path)});
        iconActor.visible = true;
    } catch (_e) { /* actor gone */ }
}

// Extracts an image URL from an article's HTML (og:image / twitter:image).
function extractOgImage(html) {
    if (!html)
        return '';
    const pats = [
        /<meta[^>]+property=["']og:image(?::url)?["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::url)?["']/i,
        /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
    ];
    for (const re of pats) {
        const m = re.exec(html);
        if (m && m[1])
            return m[1].replace(/&amp;/g, '&');
    }
    return '';
}

// Downloads an image URL, saves + crops it to a square, and shows it on `icon`.
function downloadAndCrop(session, imgUrl, base, size, icon) {
    let msg;
    try { msg = Soup.Message.new('GET', imgUrl); } catch (_e) { return; }
    try { msg.request_headers.append('User-Agent', 'Mozilla/5.0'); } catch (_e) { /* ok */ }
    session.send_and_read_async(msg, GLib.PRIORITY_LOW, null, (s, res) => {
        try {
            const bytes = session.send_and_read_finish(res);
            const data = bytes.get_data();
            if (data && data.length > 128) {
                const path = base + sniffImageExt(data);
                Gio.File.new_for_path(path).replace_contents(
                    data, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
                const t = makeSquareThumb(path, size);
                if (t) applyThumb(icon, t);
            }
        } catch (_e) { /* ignore image errors */ }
    });
}

// Shows a thumbnail for an article: prefers the feed's direct image; if none,
// fetches the article page and extracts its og:image. Keyed/cached by the
// article URL, so re-opens reuse the cropped thumbnail.
function loadNewsThumb(session, articleUrl, directImg, icon, size) {
    // Google News links are redirects whose og:image is the generic GN logo;
    // without a direct image there's nothing useful to show.
    if (!directImg && (!articleUrl || articleUrl.includes('news.google.com')))
        return;
    const base = newsImageBase(articleUrl || directImg || '');
    const sq = `${base}.sq${size}.png`;
    if (GLib.file_test(sq, GLib.FileTest.EXISTS)) { applyThumb(icon, sq); return; }
    const orig = existingNewsImage(base);
    if (orig) {
        const t = makeSquareThumb(orig, size);
        if (t) applyThumb(icon, t);
        return;
    }
    if (directImg) {
        downloadAndCrop(session, directImg, base, size, icon);
        return;
    }
    if (!articleUrl)
        return;
    // No direct image: fetch the article and read its og:image.
    let msg;
    try { msg = Soup.Message.new('GET', articleUrl); } catch (_e) { return; }
    try { msg.request_headers.append('User-Agent', 'Mozilla/5.0'); } catch (_e) { /* ok */ }
    session.send_and_read_async(msg, GLib.PRIORITY_LOW, null, (s, res) => {
        try {
            const bytes = session.send_and_read_finish(res);
            const html = new TextDecoder().decode(bytes.get_data());
            const og = extractOgImage(html);
            if (og)
                downloadAndCrop(session, og, base, size, icon);
        } catch (_e) { /* ignore */ }
    });
}

// Relative age from a GDELT "YYYYMMDDTHHMMSSZ" timestamp.
function gdeltAge(seendate) {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(seendate || '');
    if (!m)
        return '';
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    const mins = Math.max(0, Math.floor((Date.now() - t) / 60000));
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60);
    if (h < 24) return `${h} h`;
    return `${Math.floor(h / 24)} d`;
}

function makeNewsGrid(spec, _, hooks) {
    const code = (spec.country || 'CL').toUpperCase();
    const c = NEWS_COUNTRIES[code] || NEWS_COUNTRIES.CL;
    const g = NEWS_GDELT[code] || NEWS_GDELT.CL;

    const container = new St.BoxLayout({style_class: 'dock-newsfeed', vertical: true});
    container.set_width(440);
    container.add_child(new St.Label({
        style_class: 'dock-newsfeed-title',
        text: `${_('Noticias')} · ${c.name}`,
    }));
    const scroll = new St.ScrollView({style_class: 'dock-newsfeed-scroll', y_expand: true});
    scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
    const list = new St.BoxLayout({style_class: 'dock-newsfeed-list', vertical: true});
    scroll.set_child(list);
    container.add_child(scroll);

    const rawCache = hooks && spec.id ? hooks.getCache(spec.id) : null;
    const cache = rawCache && typeof rawCache === 'object' ? rawCache : {};
    let items = (cache.country === code && Array.isArray(cache.items)) ? cache.items : [];
    // If the cache is recent, show it and skip the immediate GDELT call (avoids
    // hammering/rate-limiting GDELT every time the grid is reopened).
    const fresh = items.length && cache.ts && (Date.now() - cache.ts < 14 * 60 * 1000);

    const imgSession = new Soup.Session();

    const render = () => {
        list.destroy_all_children();
        if (!items.length) {
            list.add_child(new St.Label({style_class: 'dock-newsfeed-empty', text: _('Cargando…')}));
            return;
        }
        for (const it of items.slice(0, 20)) {
            const cardBtn = new St.Button({
                style_class: 'dock-newsfeed-card',
                x_expand: true, x_align: Clutter.ActorAlign.FILL,
            });
            const row = new St.BoxLayout({
                style_class: 'dock-newsfeed-row',
                x_expand: true, x_align: Clutter.ActorAlign.FILL,
            });
            // Thumbnail painted the proven way (St.Icon + Gio.FileIcon),
            // pre-cropped to a square. Hidden until an image actually loads, so
            // articles without any image just show text (no empty square).
            const thumb = new St.Icon({
                style_class: 'dock-newsfeed-thumb',
                icon_size: 84,
                y_align: Clutter.ActorAlign.START,
            });
            thumb.visible = false;
            row.add_child(thumb);
            loadNewsThumb(imgSession, it.link, it.img, thumb, 168);
            const vb = new St.BoxLayout({
                vertical: true, x_expand: true, x_align: Clutter.ActorAlign.FILL,
            });
            const meta = new St.BoxLayout({style_class: 'dock-newsfeed-meta'});
            meta.add_child(new St.Label({
                style_class: 'dock-newsfeed-source', text: it.source || _('Noticias'),
            }));
            const age = it.gdelt ? gdeltAge(it.date) : relativeAge(it.date, _);
            if (age)
                meta.add_child(new St.Label({style_class: 'dock-newsfeed-age', text: `  ·  ${age}`}));
            vb.add_child(meta);
            const h = new St.Label({style_class: 'dock-newsfeed-headline', text: it.title});
            h.clutter_text.set_line_wrap(true);
            vb.add_child(h);
            row.add_child(vb);
            cardBtn.set_child(row);
            cardBtn.connect('clicked', () => {
                if (it.link) {
                    try { Gio.AppInfo.launch_default_for_uri(it.link, null); } catch (_e) { /* ok */ }
                }
            });
            list.add_child(cardBtn);
        }
    };
    render();

    const session = new Soup.Session();
    let timer = 0;

    const commit = (newItems) => {
        if (!newItems.length)
            return;
        items = newItems;
        render();
        if (hooks && spec.id)
            hooks.setCache(spec.id, {items, country: code, ts: Date.now()});
    };

    // Fallback: Google News RSS (text only) when GDELT yields nothing.
    const fetchGoogle = () => {
        const url = `https://news.google.com/rss?hl=${c.hl}&gl=${c.gl}&ceid=${c.gl}:${c.lang}`;
        let msg;
        try { msg = Soup.Message.new('GET', url); } catch (_e) { return; }
        try { msg.request_headers.append('User-Agent', 'Mozilla/5.0'); } catch (_e) { /* ok */ }
        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
            try {
                const bytes = session.send_and_read_finish(res);
                const xml = new TextDecoder().decode(bytes.get_data());
                commit(parseRssItems(xml, 25).map(x => Object.assign({}, x, {img: '', gdelt: false})));
            } catch (_e) { /* keep last */ }
        });
    };

    const fetchGdelt = () => {
        const q = encodeURIComponent(`sourcecountry:${g.cc} sourcelang:${g.lang}`);
        const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${q}` +
            '&mode=artlist&maxrecords=30&sort=datedesc&format=json';
        let msg;
        try { msg = Soup.Message.new('GET', url); } catch (_e) { return; }
        try { msg.request_headers.append('User-Agent', 'Mozilla/5.0'); } catch (_e) { /* ok */ }
        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
            let arts = [];
            try {
                const bytes = session.send_and_read_finish(res);
                const data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                arts = Array.isArray(data.articles) ? data.articles : [];
            } catch (_e) {
                arts = [];
            }
            const mapped = arts.map(a => ({
                title: (a.title || '').trim(),
                link: a.url || '',
                source: a.domain || '',
                date: a.seendate || '',
                img: a.socialimage || '',
                gdelt: true,
            })).filter(x => x.title && x.link);
            if (mapped.length)
                commit(mapped);
            else if (!items.length)
                fetchGoogle();   // only fall back when we have nothing cached
        });
    };

    if (!fresh)
        fetchGdelt();
    timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 900, () => { fetchGdelt(); return GLib.SOURCE_CONTINUE; });

    return {
        actor: container,
        destroy() {
            if (timer) { GLib.source_remove(timer); timer = 0; }
            try { session.abort(); } catch (_e) { /* ok */ }
            try { imgSession.abort(); } catch (_e) { /* ok */ }
        },
    };
}

// -------------------------------------------------------- Grid: music player
// A large now-playing card (image-1 style) with art, title/artist, a progress
// bar and prev/play-pause/next, driven over MPRIS.
function fmtClock(us) {
    if (!us || us < 0) return '0:00';
    const s = Math.floor(us / 1e6);
    const m = Math.floor(s / 60);
    const ss = s % 60;
    return `${m}:${ss < 10 ? '0' + ss : ss}`;
}

function makeMprisGrid(spec, _) {
    const bus = Gio.DBus.session;
    const container = new St.BoxLayout({style_class: 'dock-mpris-grid', vertical: true});
    container.set_width(300);

    const art = new St.Icon({
        style_class: 'dock-mpris-grid-art',
        icon_name: 'audio-x-generic-symbolic',
        icon_size: 128,
    });
    container.add_child(new St.Bin({x_align: CENTER, child: art}));

    const title = new St.Label({style_class: 'dock-mpris-grid-title', x_align: CENTER});
    title.clutter_text.set_ellipsize(3);
    const artist = new St.Label({style_class: 'dock-mpris-grid-artist', x_align: CENTER});
    artist.clutter_text.set_ellipsize(3);
    container.add_child(title);
    container.add_child(artist);

    const track = new St.BoxLayout({style_class: 'dock-mpris-grid-track'});
    const TRACK_W = 260;
    track.set_width(TRACK_W);
    const fill = new St.Widget({style_class: 'dock-mpris-grid-fill'});
    fill.set_width(0);
    track.add_child(fill);
    container.add_child(new St.Bin({x_align: CENTER, child: track}));

    const times = new St.BoxLayout({style_class: 'dock-mpris-grid-times'});
    const elapsed = new St.Label({style_class: 'dock-mpris-grid-time', text: '0:00', x_expand: true, x_align: Clutter.ActorAlign.START});
    const total = new St.Label({style_class: 'dock-mpris-grid-time', text: '0:00', x_align: Clutter.ActorAlign.END});
    times.add_child(elapsed);
    times.add_child(total);
    container.add_child(times);

    const controls = new St.BoxLayout({style_class: 'dock-mpris-grid-ctl', x_align: CENTER});
    const mkBtn = (iconName) => new St.Button({
        style_class: 'dock-mpris-grid-btn',
        child: new St.Icon({icon_name: iconName, icon_size: 22}),
    });
    const prevB = mkBtn('media-skip-backward-symbolic');
    const ppB = mkBtn('media-playback-start-symbolic');
    const nextB = mkBtn('media-skip-forward-symbolic');
    controls.add_child(prevB);
    controls.add_child(ppB);
    controls.add_child(nextB);
    container.add_child(controls);

    let curProxy = null;
    let curName = null;
    const mkProxy = (n) => Gio.DBusProxy.new_sync(
        bus, Gio.DBusProxyFlags.NONE, null, n, MPRIS_PATH, MPRIS_IFACE, null);
    const listPlayers = () => {
        try {
            const reply = bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus',
                'org.freedesktop.DBus', 'ListNames', null, null,
                Gio.DBusCallFlags.NONE, -1, null);
            return reply.deep_unpack()[0].filter(n => n.startsWith('org.mpris.MediaPlayer2.'));
        } catch (_e) { return []; }
    };
    const pick = () => {
        let fallback = null;
        for (const n of listPlayers()) {
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
    const callPlayer = (method) => {
        if (curProxy) {
            try { curProxy.call(method, null, Gio.DBusCallFlags.NONE, -1, null, null); } catch (_e) { /* ok */ }
        }
    };
    prevB.connect('clicked', () => callPlayer('Previous'));
    nextB.connect('clicked', () => callPlayer('Next'));
    ppB.connect('clicked', () => callPlayer('PlayPause'));

    const getPosition = () => {
        if (!curProxy || !curName) return -1;
        try {
            const r = curProxy.g_connection.call_sync(
                curName, MPRIS_PATH, 'org.freedesktop.DBus.Properties', 'Get',
                new GLib.Variant('(ss)', [MPRIS_IFACE, 'Position']),
                new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, 300, null);
            return r.deep_unpack()[0].deep_unpack();
        } catch (_e) { return -1; }
    };

    const refresh = () => {
        const sel = pick();
        curProxy = sel ? sel.proxy : null;
        curName = sel ? sel.name : null;
        if (!curProxy) {
            title.text = _('Nada reproduciéndose');
            artist.text = '';
            art.gicon = null;
            art.icon_name = 'audio-x-generic-symbolic';
            ppB.child.icon_name = 'media-playback-start-symbolic';
            fill.set_width(0);
            elapsed.text = '0:00';
            total.text = '0:00';
            return GLib.SOURCE_CONTINUE;
        }
        let t = '', a = '', url = '', len = 0;
        const md = curProxy.get_cached_property('Metadata');
        if (md) {
            const m = md.deep_unpack();
            if (m['xesam:title']) t = m['xesam:title'].deep_unpack();
            if (m['xesam:artist']) {
                const arr = m['xesam:artist'].deep_unpack();
                a = Array.isArray(arr) ? arr.join(', ') : String(arr);
            }
            if (m['mpris:artUrl']) url = m['mpris:artUrl'].deep_unpack();
            if (m['mpris:length']) { try { len = Number(m['mpris:length'].deep_unpack()); } catch (_e) { len = 0; } }
        }
        title.text = t || _('Nada reproduciéndose');
        artist.text = a;
        if (url && url.startsWith('file://')) {
            try { art.gicon = new Gio.FileIcon({file: Gio.File.new_for_uri(url)}); }
            catch (_e) { art.gicon = null; art.icon_name = 'audio-x-generic-symbolic'; }
        } else {
            art.gicon = null;
            art.icon_name = 'audio-x-generic-symbolic';
        }
        const st = curProxy.get_cached_property('PlaybackStatus');
        const playing = st && st.unpack() === 'Playing';
        ppB.child.icon_name = playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';

        if (len > 0) {
            const pos = getPosition();
            const frac = pos >= 0 ? Math.max(0, Math.min(1, pos / len)) : 0;
            fill.set_width(Math.round(TRACK_W * frac));
            elapsed.text = fmtClock(pos);
            total.text = fmtClock(len);
        } else {
            fill.set_width(0);
            elapsed.text = '0:00';
            total.text = '0:00';
        }
        return GLib.SOURCE_CONTINUE;
    };
    refresh();
    const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, refresh);

    return {
        actor: container,
        destroy() { if (timer) GLib.source_remove(timer); },
    };
}

// ------------------------------------------------------------- Grid: AI chat
// Integrated chat with Gemini / ChatGPT / Claude over each provider's API.
// The user's API key is read from GSettings (via hooks.getChatKey) and is sent
// ONLY to that provider's official endpoint.
function chatProviderName(p) {
    return {claude: 'Claude', openai: 'ChatGPT', gemini: 'Gemini', local: 'Local'}[p] || 'IA';
}

function chatDefaultModel(p) {
    return {
        claude: 'claude-haiku-4-5-20251001',
        openai: 'gpt-4o-mini',
        gemini: 'gemini-1.5-flash',
        local: 'qwen2.5:3b',   // Ollama id; LM-Studio would be qwen2.5-3b-instruct
    }[p] || '';
}

// Sends the conversation `history` ([{role:'user'|'assistant', content}]) to the
// provider and calls cb(text, errorString). `baseUrl` is used by the 'local'
// provider (LM-Studio / Ollama, OpenAI-compatible).
function chatSend(session, provider, key, model, history, cb, baseUrl) {
    let url;
    const headers = {};
    let body;
    if (provider === 'local') {
        const base = (baseUrl || 'http://localhost:1234/v1').replace(/\/+$/, '');
        url = `${base}/chat/completions`;
        if (key)
            headers['Authorization'] = `Bearer ${key}`;   // optional for local
        body = {
            model: model || 'local-model',
            messages: history.map(m => ({role: m.role, content: m.content})),
            stream: false,
        };
    } else if (provider === 'openai') {
        url = 'https://api.openai.com/v1/chat/completions';
        headers['Authorization'] = `Bearer ${key}`;
        body = {model, messages: history.map(m => ({role: m.role, content: m.content}))};
    } else if (provider === 'gemini') {
        url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
        body = {contents: history.map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{text: m.content}],
        }))};
    } else { // claude (default)
        url = 'https://api.anthropic.com/v1/messages';
        headers['x-api-key'] = key;
        headers['anthropic-version'] = '2023-06-01';
        body = {model, max_tokens: 1024, messages: history.map(m => ({role: m.role, content: m.content}))};
    }

    let msg;
    try { msg = Soup.Message.new('POST', url); } catch (_e) { cb(null, 'URL inválida'); return; }
    for (const h in headers) {
        try { msg.request_headers.append(h, headers[h]); } catch (_e) { /* ok */ }
    }
    try {
        const bytes = new GLib.Bytes(new TextEncoder().encode(JSON.stringify(body)));
        msg.set_request_body_from_bytes('application/json', bytes);
    } catch (e) {
        cb(null, 'No se pudo preparar la solicitud');
        return;
    }
    session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
        try {
            const resp = session.send_and_read_finish(res);
            const txt = new TextDecoder().decode(resp.get_data());
            const data = JSON.parse(txt);
            let out = '';
            if (provider === 'openai' || provider === 'local')
                out = data.choices && data.choices[0] ? (data.choices[0].message.content || '') : '';
            else if (provider === 'gemini')
                out = data.candidates && data.candidates[0]
                    ? data.candidates[0].content.parts.map(p => p.text || '').join('') : '';
            else
                out = Array.isArray(data.content) ? data.content.map(c => c.text || '').join('') : '';
            if (out && out.trim())
                cb(out.trim(), null);
            else {
                const err = (data.error && (data.error.message || data.error.type || data.error)) ||
                    data['error'] || 'Respuesta vacía o error del servicio';
                cb(null, String(err));
            }
        } catch (_e) {
            cb(null, 'Error de red o de respuesta');
        }
    });
}

function makeChatGrid(spec, _, hooks) {
    const provider = spec.provider || 'local';
    const model = (spec.model && spec.model.trim()) || chatDefaultModel(provider);
    const isLocal = provider === 'local';
    const key = (!isLocal && hooks && hooks.getChatKey) ? (hooks.getChatKey(provider) || '') : '';
    const baseUrl = (isLocal && hooks && hooks.getChatLocalUrl)
        ? (hooks.getChatLocalUrl() || 'http://localhost:1234/v1') : '';
    const ready = isLocal || !!key;

    const container = new St.BoxLayout({style_class: 'dock-chat', vertical: true});
    container.set_width(380);

    const header = new St.BoxLayout({style_class: 'dock-chat-head'});
    header.add_child(new St.Icon({icon_name: 'user-available-symbolic', icon_size: 16}));
    header.add_child(new St.Label({
        style_class: 'dock-chat-title', text: chatProviderName(provider),
        x_expand: true, y_align: CENTER,
    }));
    container.add_child(header);

    const scroll = new St.ScrollView({style_class: 'dock-chat-scroll', y_expand: true});
    scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
    const msgs = new St.BoxLayout({style_class: 'dock-chat-msgs', vertical: true});
    scroll.set_child(msgs);
    container.add_child(scroll);

    const inputRow = new St.BoxLayout({style_class: 'dock-chat-input'});
    const entry = new St.Entry({
        style_class: 'dock-chat-entry', can_focus: true, x_expand: true,
    });
    entry.set_hint_text(_('Escribe un mensaje…'));
    const sendBtn = new St.Button({
        style_class: 'dock-chat-send',
        child: new St.Icon({icon_name: 'mail-send-symbolic', icon_size: 18}),
    });
    inputRow.add_child(entry);
    inputRow.add_child(sendBtn);
    container.add_child(inputRow);

    const history = [];
    const session = new Soup.Session();

    const scrollToBottom = () => {
        const adj = scroll.vadjustment ||
            (scroll.get_vadjustment ? scroll.get_vadjustment() : null);
        if (adj) {
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                adj.value = Math.max(0, adj.upper - adj.page_size);
                return GLib.SOURCE_REMOVE;
            });
        }
    };
    const addBubble = (role, text) => {
        const bubble = new St.BoxLayout({
            style_class: `dock-chat-bubble ${role === 'user' ? 'user' : 'ai'}`,
            vertical: true,
            x_expand: true,
            x_align: role === 'user' ? Clutter.ActorAlign.END : Clutter.ActorAlign.START,
        });
        const l = new St.Label({style_class: 'dock-chat-text', text});
        l.clutter_text.set_line_wrap(true);
        l.clutter_text.set_ellipsize(0 /* NONE: show the whole answer, wrapped */);
        try { l.clutter_text.set_selectable(true); } catch (_e) { /* ok */ }
        bubble.add_child(l);
        msgs.add_child(bubble);
        scrollToBottom();
        return l;
    };

    // iMessage-style time stamp at the top.
    msgs.add_child(new St.Label({
        style_class: 'dock-chat-ts',
        text: GLib.DateTime.new_now_local().format('%A %H:%M'),
        x_align: CENTER,
    }));

    if (!ready)
        addBubble('ai', _('Configura tu clave API en Preferencias → Widgets para usar el chat.'));
    else if (isLocal)
        addBubble('ai', _('Modelo local listo. ¿En qué te ayudo?'));
    else
        addBubble('ai', _('Hola, ¿en qué te ayudo?'));

    let busy = false;
    const send = () => {
        const text = entry.get_text().trim();
        if (!text || busy)
            return;
        if (!ready) {
            addBubble('ai', _('Falta la clave API. Añádela en Preferencias → Widgets.'));
            return;
        }
        entry.set_text('');
        addBubble('user', text);
        history.push({role: 'user', content: text});
        busy = true;
        const pending = addBubble('ai', '…');
        chatSend(session, provider, key, model, history, (out, err) => {
            busy = false;
            if (out) {
                pending.text = out;
                history.push({role: 'assistant', content: out});
            } else {
                pending.text = `⚠ ${err || _('Error')}`;
            }
            scrollToBottom();
        }, baseUrl);
    };
    sendBtn.connect('clicked', send);
    entry.clutter_text.connect('activate', send);
    entry.connect('button-press-event', () => { entry.grab_key_focus(); return Clutter.EVENT_PROPAGATE; });

    return {
        actor: container,
        destroy() { try { session.abort(); } catch (_e) { /* ok */ } },
    };
}
