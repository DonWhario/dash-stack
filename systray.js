/* Dock Stack — tray host (StatusNotifierItem / AppIndicator)
 * Registers org.kde.StatusNotifierWatcher, acts as the host and shows the
 * apps' tray icons in the GNOME top panel.
 */

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const WATCHER_NAME = 'org.kde.StatusNotifierWatcher';
const WATCHER_PATH = '/StatusNotifierWatcher';

const WATCHER_XML = `<node>
<interface name="org.kde.StatusNotifierWatcher">
  <method name="RegisterStatusNotifierItem"><arg type="s" direction="in" name="service"/></method>
  <method name="RegisterStatusNotifierHost"><arg type="s" direction="in" name="service"/></method>
  <property name="RegisteredStatusNotifierItems" type="as" access="read"/>
  <property name="IsStatusNotifierHostRegistered" type="b" access="read"/>
  <property name="ProtocolVersion" type="i" access="read"/>
  <signal name="StatusNotifierItemRegistered"><arg type="s"/></signal>
  <signal name="StatusNotifierItemUnregistered"><arg type="s"/></signal>
  <signal name="StatusNotifierHostRegistered"/>
</interface>
</node>`;

const ITEM_XML = `<node>
<interface name="org.kde.StatusNotifierItem">
  <property name="Id" type="s" access="read"/>
  <property name="Title" type="s" access="read"/>
  <property name="Status" type="s" access="read"/>
  <property name="IconName" type="s" access="read"/>
  <property name="IconThemePath" type="s" access="read"/>
  <property name="AttentionIconName" type="s" access="read"/>
  <property name="Menu" type="o" access="read"/>
  <property name="ItemIsMenu" type="b" access="read"/>
  <property name="IconPixmap" type="a(iiay)" access="read"/>
  <property name="AttentionIconPixmap" type="a(iiay)" access="read"/>
  <method name="Activate"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
  <method name="SecondaryActivate"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
  <method name="ContextMenu"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
  <method name="Scroll"><arg type="i" direction="in"/><arg type="s" direction="in"/></method>
  <signal name="NewIcon"/>
  <signal name="NewAttentionIcon"/>
  <signal name="NewTitle"/>
  <signal name="NewToolTip"/>
  <signal name="NewStatus"><arg type="s"/></signal>
</interface>
</node>`;

const ItemProxy = Gio.DBusProxy.makeProxyWrapper(ITEM_XML);

// ---- Converts an SNI pixmap (ARGB32 big-endian) to a Gio.Icon PNG ----
function pixmapToGicon(pixmaps) {
    if (!pixmaps || pixmaps.length === 0)
        return null;
    // Pick the one with the largest area
    let best = null;
    for (const p of pixmaps) {
        const w = p[0], h = p[1];
        if (w > 0 && h > 0 && (!best || w * h > best[0] * best[1]))
            best = p;
    }
    if (!best)
        return null;
    const [w, h, data] = best;
    try {
        const src = data instanceof Uint8Array ? data : Uint8Array.from(data);
        const out = new Uint8Array(w * h * 4);
        for (let i = 0; i < w * h; i++) {
            const a = src[i * 4 + 0];
            const r = src[i * 4 + 1];
            const g = src[i * 4 + 2];
            const b = src[i * 4 + 3];
            out[i * 4 + 0] = r;
            out[i * 4 + 1] = g;
            out[i * 4 + 2] = b;
            out[i * 4 + 3] = a;
        }
        const pixbuf = GdkPixbuf.Pixbuf.new_from_bytes(
            new GLib.Bytes(out), GdkPixbuf.Colorspace.RGB, true, 8, w, h, w * 4);
        const [ok, buf] = pixbuf.save_to_bufferv('png', [], []);
        if (!ok)
            return null;
        return Gio.BytesIcon.new(new GLib.Bytes(buf));
    } catch (e) {
        logError(e, 'Dock Stack systray: pixmap');
        return null;
    }
}

// ================================================================= TrayIcon
const TrayIcon = GObject.registerClass(
class TrayIcon extends PanelMenu.Button {
    _init(busName, objectPath, onDestroyCb) {
        super._init(0.5, busName, false);
        this._busName = busName;
        this._objectPath = objectPath;
        this._onDestroyCb = onDestroyCb;

        this._icon = new St.Icon({style_class: 'system-status-icon'});
        this.add_child(this._icon);

        // GNOME 50: los clics no llegan por vfunc_event; usar señales explícitas.
        this.connect('button-press-event', (_a, event) => this._onButtonPress(event));
        this.connect('scroll-event', (_a, event) => this._onScroll(event));

        this._proxy = new ItemProxy(Gio.DBus.session, busName, objectPath,
            (proxy, error) => {
                if (error) {
                    logError(error, 'Dock Stack systray: proxy');
                    return;
                }
                this._refresh();
            });

        // Item change signals
        this._sigIds = [];
        for (const sig of ['NewIcon', 'NewAttentionIcon', 'NewStatus', 'NewTitle', 'NewToolTip']) {
            try {
                this._sigIds.push(this._proxy.connectSignal(sig, () => this._refresh()));
            } catch (_e) { /* ignore */ }
        }

        this.connect('destroy', () => this._onDestroy());
    }

    // Click handling (single path via the 'button-press-event' signal, to avoid
    // double handling with vfunc_event across GNOME versions).
    //
    // Behavior matches AppIndicator/KStatusNotifierItem support:
    //  - Left click:  if the item is menu-only (ItemIsMenu) or has a menu but
    //                 no usable Activate, show its menu; otherwise Activate.
    //  - Middle:      SecondaryActivate.
    //  - Right click: always show the menu (dbusmenu, or ContextMenu fallback).
    _onButtonPress(event) {
        const btn = event.get_button();
        const [x, y] = global.get_pointer();
        if (btn === 1) {
            if (this._itemIsMenu && this._hasMenu())
                this._showMenu(x, y);
            else
                this._activate(x, y);
            return Clutter.EVENT_STOP;
        } else if (btn === 2) {
            this._call('SecondaryActivate', x, y);
            return Clutter.EVENT_STOP;
        } else if (btn === 3) {
            this._showMenu(x, y);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _hasMenu() {
        return !!(this._menuPath && this._menuPath !== '/');
    }

    // Shows the app's menu: the com.canonical.dbusmenu layout if available,
    // otherwise asks the item to show its own ContextMenu.
    _showMenu(x, y) {
        if (this._hasMenu())
            this._openDBusMenu();
        else
            this._call('ContextMenu', x, y);
    }

    _onScroll(event) {
        const dir = event.get_scroll_direction();
        let delta = 0, orient = 'vertical';
        if (dir === Clutter.ScrollDirection.UP) delta = -1;
        else if (dir === Clutter.ScrollDirection.DOWN) delta = 1;
        else if (dir === Clutter.ScrollDirection.LEFT) { delta = -1; orient = 'horizontal'; }
        else if (dir === Clutter.ScrollDirection.RIGHT) { delta = 1; orient = 'horizontal'; }
        if (delta !== 0)
            this._callScroll(delta, orient);
        return Clutter.EVENT_STOP;
    }

    // Activate with a fallback: if the app doesn't implement Activate and it has
    // a menu, show the menu instead (so menu-only apps still respond to a click).
    _activate(x, y) {
        try {
            this._proxy.g_connection.call(
                this._busName, this._objectPath, 'org.kde.StatusNotifierItem',
                'Activate', new GLib.Variant('(ii)', [Math.round(x), Math.round(y)]),
                null, Gio.DBusCallFlags.NONE, -1, null,
                (conn, res) => {
                    try {
                        conn.call_finish(res);
                    } catch (_e) {
                        if (this._hasMenu())
                            this._showMenu(x, y);
                    }
                });
        } catch (_e) {
            if (this._hasMenu())
                this._showMenu(x, y);
        }
    }

    _call(method, x, y) {
        try {
            this._proxy.g_connection.call(
                this._busName, this._objectPath, 'org.kde.StatusNotifierItem', method,
                new GLib.Variant('(ii)', [Math.round(x), Math.round(y)]),
                null, Gio.DBusCallFlags.NONE, -1, null, null);
        } catch (e) {
            logError(e, `Dock Stack systray: ${method}`);
        }
    }

    _callScroll(delta, orient) {
        try {
            this._proxy.g_connection.call(
                this._busName, this._objectPath, 'org.kde.StatusNotifierItem', 'Scroll',
                new GLib.Variant('(is)', [delta, orient]),
                null, Gio.DBusCallFlags.NONE, -1, null, null);
        } catch (_e) { /* ignore */ }
    }

    // Re-reads properties (SNI doesn't always emit PropertiesChanged)
    _refresh() {
        this._proxy.g_connection.call(
            this._busName, this._objectPath,
            'org.freedesktop.DBus.Properties', 'GetAll',
            new GLib.Variant('(s)', ['org.kde.StatusNotifierItem']),
            new GLib.VariantType('(a{sv})'), Gio.DBusCallFlags.NONE, -1, null,
            (conn, res) => {
                let props;
                try {
                    const v = conn.call_finish(res);
                    props = v.deep_unpack()[0];
                } catch (_e) {
                    return;
                }
                this._applyProps(props);
            });
    }

    _applyProps(props) {
        const get = (k) => (props[k] ? props[k].deep_unpack() : undefined);
        const status = get('Status') || 'Active';
        this._menuPath = get('Menu') || null;
        // ItemIsMenu: the app has no useful Activate; a click should show its menu.
        this._itemIsMenu = get('ItemIsMenu') === true;

        // Hide if the item is passive
        this.visible = status !== 'Passive';

        const useAttention = status === 'NeedsAttention';
        const iconName = useAttention ? (get('AttentionIconName') || get('IconName')) : get('IconName');
        const themePath = get('IconThemePath') || '';

        let gicon = null;
        if (iconName && iconName.length) {
            if (iconName[0] === '/') {
                gicon = Gio.icon_new_for_string(iconName);
            } else if (themePath) {
                // Look for the file in the app's own theme path
                for (const ext of ['.png', '.svg', '']) {
                    const p = GLib.build_filenamev([themePath, iconName + ext]);
                    if (GLib.file_test(p, GLib.FileTest.EXISTS)) {
                        gicon = Gio.icon_new_for_string(p);
                        break;
                    }
                }
                if (!gicon)
                    gicon = new Gio.ThemedIcon({name: iconName});
            } else {
                gicon = new Gio.ThemedIcon({name: iconName});
            }
        }
        if (!gicon) {
            const pix = useAttention ? get('AttentionIconPixmap') : get('IconPixmap');
            gicon = pixmapToGicon(pix) || pixmapToGicon(get('IconPixmap'));
        }
        if (!gicon)
            gicon = new Gio.ThemedIcon({name: 'application-x-executable-symbolic'});

        this._icon.set_gicon(gicon);
    }

    // ---- Basic menu (com.canonical.dbusmenu) ----
    _openDBusMenu() {
        const conn = this._proxy.g_connection;
        // AboutToShow and then GetLayout
        conn.call(this._busName, this._menuPath, 'com.canonical.dbusmenu',
            'AboutToShow', new GLib.Variant('(i)', [0]), null,
            Gio.DBusCallFlags.NONE, -1, null, () => {
                conn.call(this._busName, this._menuPath, 'com.canonical.dbusmenu',
                    'GetLayout',
                    new GLib.Variant('(iias)', [0, -1, []]),
                    new GLib.VariantType('(u(ia{sv}av))'),
                    Gio.DBusCallFlags.NONE, -1, null,
                    (c, res) => {
                        let layout;
                        try {
                            layout = c.call_finish(res).deep_unpack();
                        } catch (e) {
                            logError(e, 'Dock Stack systray: GetLayout');
                            return;
                        }
                        this._buildMenu(layout[1]);
                    });
            });
    }

    _buildMenu(root) {
        this.menu.removeAll();
        // root = [id, props, [children...]]
        const children = root[2] || [];
        for (const childV of children)
            this._addMenuNode(this.menu, this._unwrapNode(childV));
        this.menu.open();
    }

    _unwrapNode(v) {
        // v is a "v" variant wrapping (ia{sv}av)
        const val = (v && v.deep_unpack) ? v.deep_unpack() : v;
        return val;
    }

    _addMenuNode(parentMenu, node) {
        if (!node)
            return;
        const id = node[0];
        const props = node[1] || {};
        const kids = node[2] || [];
        const unpack = (k) => (props[k] && props[k].deep_unpack ? props[k].deep_unpack() : props[k]);

        const type = unpack('type');
        const visible = unpack('visible');
        if (visible === false)
            return;
        if (type === 'separator') {
            parentMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            return;
        }
        let label = unpack('label') || '';
        label = String(label).replace(/_/g, '');
        const enabled = unpack('enabled') !== false;
        const toggleType = unpack('toggle-type');
        const toggleState = unpack('toggle-state');

        if (kids && kids.length) {
            const sub = new PopupMenu.PopupSubMenuMenuItem(label);
            parentMenu.addMenuItem(sub);
            for (const k of kids)
                this._addMenuNode(sub.menu, this._unwrapNode(k));
            return;
        }

        let item;
        if (toggleType === 'checkmark' || toggleType === 'radio') {
            item = new PopupMenu.PopupSwitchMenuItem(label, toggleState === 1);
        } else {
            item = new PopupMenu.PopupMenuItem(label);
        }
        item.setSensitive(enabled);
        item.connect('activate', () => {
            this._menuEvent(id);
        });
        parentMenu.addMenuItem(item);
    }

    _menuEvent(id) {
        try {
            this._proxy.g_connection.call(
                this._busName, this._menuPath, 'com.canonical.dbusmenu', 'Event',
                new GLib.Variant('(isvu)', [id, 'clicked',
                    new GLib.Variant('i', 0),
                    Math.floor(Date.now() / 1000)]),
                null, Gio.DBusCallFlags.NONE, -1, null, null);
        } catch (e) {
            logError(e, 'Dock Stack systray: menu Event');
        }
    }

    _onDestroy() {
        if (this._sigIds && this._proxy) {
            for (const id of this._sigIds) {
                try {
                    this._proxy.disconnectSignal(id);
                } catch (_e) { /* ignore */ }
            }
        }
        this._sigIds = null;
        this._proxy = null;
        if (this._onDestroyCb)
            this._onDestroyCb(this);
    }
});

// ============================================================ SysTrayManager
export class SysTrayManager {
    constructor(uuid) {
        this._uuid = uuid;
        this._items = new Map();       // key "busName+path" -> TrayIcon
        this._nameWatchers = new Map(); // key -> watcher id
        this._ownId = 0;
        this._hostId = 0;
        this._regId = 0;
        this._hostRegistered = false;
    }

    enable() {
        this._nodeInfo = Gio.DBusNodeInfo.new_for_xml(WATCHER_XML);
        this._ifaceInfo = this._nodeInfo.interfaces[0];

        this._ownId = Gio.bus_own_name(
            Gio.BusType.SESSION, WATCHER_NAME,
            Gio.BusNameOwnerFlags.NONE,
            (conn) => this._onBusAcquired(conn),
            () => this._onNameAcquired(),
            () => { /* nombre perdido: otro watcher existe */ });
    }

    _onBusAcquired(conn) {
        this._conn = conn;
        try {
            this._regId = conn.register_object(
                WATCHER_PATH, this._ifaceInfo,
                (c, sender, path, iface, method, params, invocation) =>
                    this._onMethod(c, sender, method, params, invocation),
                (c, sender, path, iface, prop) => this._onGetProp(prop),
                null);
        } catch (e) {
            logError(e, 'Dock Stack systray: register_object');
        }
    }

    _onNameAcquired() {
        // Register ourselves as host (unique name)
        const hostName = `org.kde.StatusNotifierHost-DockStack-${GLib.uuid_string_random().replace(/-/g, '')}`;
        this._hostId = Gio.bus_own_name(
            Gio.BusType.SESSION, hostName, Gio.BusNameOwnerFlags.NONE,
            null,
            () => {
                this._hostRegistered = true;
                this._emit('StatusNotifierHostRegistered', null);
            },
            null);
    }

    _onMethod(conn, sender, method, params, invocation) {
        if (method === 'RegisterStatusNotifierItem') {
            const service = params.deep_unpack()[0];
            let busName, objPath;
            if (service && service[0] === '/') {
                busName = sender;
                objPath = service;
            } else if (service && service.includes('/')) {
                const idx = service.indexOf('/');
                busName = service.slice(0, idx);
                objPath = service.slice(idx);
            } else {
                busName = service || sender;
                objPath = '/StatusNotifierItem';
            }
            this._addItem(busName, objPath);
            invocation.return_value(null);
        } else if (method === 'RegisterStatusNotifierHost') {
            this._hostRegistered = true;
            invocation.return_value(null);
            this._emit('StatusNotifierHostRegistered', null);
        } else {
            invocation.return_value(null);
        }
    }

    _onGetProp(prop) {
        if (prop === 'RegisteredStatusNotifierItems')
            return new GLib.Variant('as', [...this._items.keys()]);
        if (prop === 'IsStatusNotifierHostRegistered')
            return new GLib.Variant('b', true);
        if (prop === 'ProtocolVersion')
            return new GLib.Variant('i', 0);
        return null;
    }

    _emit(signal, args) {
        if (!this._conn)
            return;
        try {
            this._conn.emit_signal(null, WATCHER_PATH, WATCHER_NAME, signal, args);
        } catch (_e) { /* ignore */ }
    }

    _addItem(busName, objPath) {
        const key = busName + objPath;
        if (this._items.has(key))
            return;

        const icon = new TrayIcon(busName, objPath, () => {});
        this._items.set(key, icon);
        Main.panel.addToStatusArea(`dock-stack-tray-${key}`, icon, 0, 'right');

        // Watch that the bus owner still exists
        const watchId = Gio.bus_watch_name(
            Gio.BusType.SESSION, busName, Gio.BusNameWatcherFlags.NONE,
            null,
            () => this._removeItem(key)); // vanished
        this._nameWatchers.set(key, watchId);

        this._emit('StatusNotifierItemRegistered',
            new GLib.Variant('(s)', [key]));
    }

    _removeItem(key) {
        const icon = this._items.get(key);
        if (icon) {
            this._items.delete(key);
            try {
                icon.destroy();
            } catch (_e) { /* ignore */ }
            this._emit('StatusNotifierItemUnregistered',
                new GLib.Variant('(s)', [key]));
        }
        const w = this._nameWatchers.get(key);
        if (w) {
            Gio.bus_unwatch_name(w);
            this._nameWatchers.delete(key);
        }
    }

    disable() {
        for (const key of [...this._items.keys()])
            this._removeItem(key);
        this._items.clear();
        this._nameWatchers.clear();

        if (this._regId && this._conn) {
            try {
                this._conn.unregister_object(this._regId);
            } catch (_e) { /* ignore */ }
            this._regId = 0;
        }
        if (this._hostId) {
            Gio.bus_unown_name(this._hostId);
            this._hostId = 0;
        }
        if (this._ownId) {
            Gio.bus_unown_name(this._ownId);
            this._ownId = 0;
        }
        this._conn = null;
    }
}
