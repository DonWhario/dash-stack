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

const CENTER = Clutter.ActorAlign.CENTER;

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

export function makeWidget(spec, iconSize, _) {
    switch (spec && spec.type) {
    case 'mpris': return makeMpris(spec, iconSize, _);
    case 'weather': return makeWeather(spec, iconSize, _);
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
    const art = new St.Icon({
        style_class: 'dock-widget-art',
        icon_name: 'audio-x-generic-symbolic',
        icon_size: iconSize,
    });
    const {col, title, sub} = textColumn(_('Nada reproduciéndose'), '');
    col.set_width(150);

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
function weatherIcon(code) {
    const c = String(code || '');
    const has = (list) => list.includes(c);
    if (has(['200', '386', '389', '392', '395'])) return 'weather-storm-symbolic';
    if (has(['179', '182', '185', '227', '230', '317', '320', '323', '326', '329',
        '332', '335', '338', '350', '362', '365', '368', '371', '374', '377']))
        return 'weather-snow-symbolic';
    if (has(['176', '263', '266', '281', '284', '293', '296', '299', '302', '305',
        '308', '311', '314', '353', '356', '359']))
        return 'weather-showers-symbolic';
    if (has(['143', '248', '260'])) return 'weather-fog-symbolic';
    if (has(['119', '122'])) return 'weather-overcast-symbolic';
    if (has(['116'])) return 'weather-few-clouds-symbolic';
    return 'weather-clear-symbolic';
}

function makeWeather(spec, iconSize, _) {
    const box = card('dock-widget-weather');
    const icon = new St.Icon({
        style_class: 'dock-widget-art',
        icon_name: 'weather-clear-symbolic',
        icon_size: iconSize,
    });
    const {col, title, sub} = textColumn(spec.location || _('Clima'), '…');
    col.set_width(150);
    box.add_child(icon);
    box.add_child(col);

    const session = new Soup.Session();
    let timer = 0;

    const fetch = () => {
        const loc = spec.location || '';
        const url = `https://wttr.in/${encodeURIComponent(loc)}?format=j1`;
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
                const desc = cur.weatherDesc && cur.weatherDesc[0] ? cur.weatherDesc[0].value : '';
                sub.text = `${cur.temp_C}°C · ${desc}`;
                icon.icon_name = weatherIcon(cur.weatherCode);
                if (data.nearest_area && data.nearest_area[0])
                    title.text = data.nearest_area[0].areaName[0].value;
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
    const show = spec.fields || {clock: true, cpu: true, ram: true, battery: true};
    const info = new St.BoxLayout({style_class: 'dock-widget-text', vertical: true, y_align: CENTER});
    const big = new St.Label({style_class: 'dock-widget-time'});
    const sub = new St.Label({style_class: 'dock-widget-sub'});
    info.add_child(big);
    info.add_child(sub);
    box.add_child(info);

    let lastCpu = readCpu();
    const tick = () => {
        const now = GLib.DateTime.new_now_local();
        big.text = show.clock ? now.format('%H:%M') : _('Sistema');
        const parts = [];
        if (show.clock) parts.push(now.format('%a %d'));
        if (show.cpu) {
            const c = readCpu();
            const dt = c.total - lastCpu.total;
            const di = c.idle - lastCpu.idle;
            const use = dt > 0 ? Math.round((1 - di / dt) * 100) : 0;
            lastCpu = c;
            parts.push(`CPU ${use}%`);
        }
        if (show.ram) parts.push(`RAM ${readRam()}%`);
        if (show.battery) { const b = readBattery(); if (b >= 0) parts.push(`BAT ${b}%`); }
        sub.text = parts.join('  ·  ');
        return GLib.SOURCE_CONTINUE;
    };
    tick();
    const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, tick);

    return {
        actor: box,
        destroy() { if (timer) GLib.source_remove(timer); },
    };
}

// -------------------------------------------------------------------- Script
function makeScript(spec, iconSize, _) {
    const box = card('dock-widget-script');
    const {col, title, sub} = textColumn('…', spec.label || '');
    col.set_width(spec.width && spec.width > 0 ? spec.width : 180);
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
