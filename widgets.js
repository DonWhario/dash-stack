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
import * as Calendar from 'resource:///org/gnome/shell/ui/calendar.js';

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
    case 'news': return makeNews(spec, iconSize, _, lang, hooks);
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

// Rich weather popup (current + hourly + 5-day) shown next to the widget.
function openForecast(sourceActor, lat, lon, name, _, hooks, spec) {
    const now = GLib.DateTime.new_now_local();
    const panelW = Math.max(sourceActor && sourceActor.width ? sourceActor.width : 0, 270);
    const rawCache = hooks && spec && spec.id ? hooks.getCache(spec.id) : null;
    const cache = rawCache && typeof rawCache === 'object' ? rawCache : {};
    const fc = cache.fc || null;   // last shown forecast (from memory)

    const container = new St.BoxLayout({style_class: 'dock-forecast', vertical: true});
    container.set_width(panelW);

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

    showPopup(container, sourceActor);

    if (lat == null || lon == null) {
        if (!fc)
            bigTemp.text = _('sin datos');
        return; // no coords: keep whatever is cached
    }

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
        '&current=temperature_2m,weather_code,wind_speed_10m,surface_pressure,relative_humidity_2m' +
        '&hourly=temperature_2m,weather_code' +
        '&daily=weather_code,temperature_2m_max,temperature_2m_min&forecast_days=5&timezone=auto';
    const session = new Soup.Session();
    let msg;
    try {
        msg = Soup.Message.new('GET', url);
    } catch (_e) {
        return; // keep cached
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

    const setBg = (uri) => box.set_style(
        `background-image: url("${uri}"); background-size: cover; background-position: center;`);

    // Initial state from the cache (last shown), so a rebuild/relaunch keeps the
    // previous look and text instead of flashing/clearing. Sunny only the very
    // first time ever.
    const soleado = dataUri('soleado.png');
    let lastBg = cache.bg || soleado;
    setBg(lastBg);
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
                // Persist the last shown snapshot.
                if (hooks && spec.id) {
                    hooks.setCache(spec.id, {
                        bg, title: titleText, sub: subText, icon: iconName, lat, lon,
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

// Extracts up to `max` {title, link} items from an RSS feed.
function parseRssItems(xml, max) {
    const items = [];
    const re = /<item\b[^>]*>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = re.exec(xml)) && items.length < (max || 20)) {
        const block = m[1];
        const tm = block.match(/<title>([\s\S]*?)<\/title>/);
        const lm = block.match(/<link>([\s\S]*?)<\/link>/);
        const title = decodeEntities(tm ? tm[1] : '').trim();
        const link = decodeEntities(lm ? lm[1] : '').trim();
        if (title)
            items.push({title, link});
    }
    return items;
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
