// GNOME Custom Application Priority Switcher
// Target: GNOME Shell 45+ (ES modules)

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const DRAG_THRESHOLD = 6; // px the pointer must move before a click becomes a drag

// Apps without a .desktop file get throw-away ids like "window:1234".
// Those are never written to disk.
const isPersistable = id => !id.startsWith('window:');

/**
 * Owns the extension's own ordering + priority data.
 *
 *  order    : every app id we have ever seen, in the user's custom order.
 *             Apps that are not running keep their slot, so relaunching
 *             Firefox puts it back where the user left it.
 *  priority : ids the user marked with the green circle.
 *
 * The displayed list is derived: running apps, priority ones first,
 * each group following `order`.
 */
class StateStore {
    constructor(path) {
        this._path = path;
        this.order = [];
        this.priority = new Set();
        this._load();
    }

    _load() {
        try {
            const [ok, bytes] = GLib.file_get_contents(this._path);
            if (!ok)
                return;
            const data = JSON.parse(new TextDecoder().decode(bytes));
            if (Array.isArray(data.order))
                this.order = [...new Set(data.order.filter(x => typeof x === 'string'))];
            if (Array.isArray(data.priority))
                this.priority = new Set(data.priority.filter(x => typeof x === 'string'));
        } catch (e) {
            // First run or unreadable file: start empty.
        }
    }

    save() {
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(this._path), 0o755);
            const data = {
                order: this.order.filter(isPersistable),
                priority: [...this.priority].filter(isPersistable),
            };
            GLib.file_set_contents(this._path, JSON.stringify(data, null, 2));
        } catch (e) {
            console.error(`[custom-app-priority-switcher] could not save state: ${e}`);
        }
    }

    /** Returns the running apps in display order (priority first). */
    arrange(runningApps) {
        const byId = new Map();
        for (const app of runningApps)
            byId.set(app.get_id(), app);

        let changed = false;

        // Forget window-backed apps that are gone.
        const kept = this.order.filter(id => isPersistable(id) || byId.has(id));
        if (kept.length !== this.order.length) {
            this.order = kept;
            changed = true;
        }

        // Newly seen apps go to the end; existing order is never touched.
        for (const id of byId.keys()) {
            if (!this.order.includes(id)) {
                this.order.push(id);
                changed = true;
            }
        }

        if (changed)
            this.save();

        const ordered = this.order.filter(id => byId.has(id)).map(id => byId.get(id));
        const isPri = app => this.priority.has(app.get_id());
        return [...ordered.filter(isPri), ...ordered.filter(app => !isPri(app))];
    }

    /**
     * Priority is a separate property, but toggling it also updates the
     * app's position so the visible sections have deterministic semantics.
     *
     * On  -> move to the bottom of the priority block.
     * Off -> move to the top of the normal block.
     */
    togglePriority(id) {
        const cur = this.order.indexOf(id);
        if (cur >= 0)
            this.order.splice(cur, 1);

        if (this.priority.has(id)) {
            this.priority.delete(id);

            // Insert before the first normal app. This makes the toggled-off
            // app the first item in the normal block when displayed.
            const firstNormal = this.order.findIndex(other => !this.priority.has(other));
            const target = firstNormal >= 0 ? firstNormal : this.order.length;
            this.order.splice(target, 0, id);
        } else {
            this.priority.add(id);

            // Insert after the last priority app.
            let lastPriority = -1;
            for (let i = 0; i < this.order.length; i++) {
                if (this.priority.has(this.order[i]))
                    lastPriority = i;
            }
            this.order.splice(lastPriority + 1, 0, id);
        }

        this.save();
    }

    /**
     * `ids` is the running apps in their new displayed order. Write them back
     * into the slots that running apps occupy in `order`, so the remembered
     * slots of non-running apps stay where they were.
     */
    applyDisplayedOrder(ids) {
        const set = new Set(ids);
        let k = 0;
        this.order = this.order.map(id => (set.has(id) ? ids[k++] : id));
        this.save();
    }
}

const AppSwitcherButton = GObject.registerClass(
class AppSwitcherButton extends PanelMenu.Button {
    _init(store) {
        super._init(0.5, 'Custom Application Priority Switcher', false);

        this._store = store;
        this._appSystem = Shell.AppSystem.get_default();
        this._press = null;
        this._pendingRefresh = false;
        this._windowChangedSignals = new Map();
        this._managedAboveWindows = new Set();

        this.add_child(new St.Icon({
            icon_name: 'view-list-symbolic',
            style_class: 'system-status-icon',
        }));

        this._list = new St.BoxLayout({
            vertical: true,
            style_class: 'cas-list',
            x_expand: true,
        });

        const scroll = new St.ScrollView({
            style_class: 'cas-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
        });
        scroll.add_child(this._list);

        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        item.add_child(scroll);
        this.menu.addMenuItem(item);

        this._appStateId = this._appSystem.connect(
            'app-state-changed', () => this._onAppsChanged());

        // Apply persisted priority to currently running windows immediately,
        // and keep watching each app for newly created windows.
        this._syncAlwaysOnTop();

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._refresh();
            else
                this._endPress();
        });

        this.connect('destroy', () => this._onCasDestroy());
    }

    _onCasDestroy() {
        try {
            this._endPress();
        } catch (e) {
            // menu actor may already be gone
        }
        if (this._appStateId) {
            this._appSystem.disconnect(this._appStateId);
            this._appStateId = 0;
        }

        for (const {app, signalId} of this._windowChangedSignals.values()) {
            try {
                app.disconnect(signalId);
            } catch (e) {
                console.error(`[custom-app-priority-switcher] could not disconnect windows-changed: ${e}`);
            }
        }
        this._windowChangedSignals.clear();
        this._clearAlwaysOnTop();
    }

    // ---- always-on-top ---------------------------------------------------

    /**
     * Make every window belonging to a priority app stay above normal
     * windows, without activating/focusing it. New windows are handled via
     * Shell.App::windows-changed. Only windows that this extension itself
     * raised are later unmade, so an unrelated always-on-top setting is not
     * accidentally removed.
     */
    _syncAlwaysOnTop() {
        const runningApps = this._appSystem.get_running();
        const liveWindows = new Set();
        const liveAppIds = new Set();

        for (const app of runningApps) {
            const id = app.get_id();
            liveAppIds.add(id);

            // Track each app's windows-changed signal exactly once.
            if (!this._windowChangedSignals.has(id)) {
                const signalId = app.connect('windows-changed', () => {
                    this._applyAppAlwaysOnTop(app);
                });
                this._windowChangedSignals.set(id, {app, signalId});
            }

            const windows = this._safeGetWindows(app);
            for (const window of windows)
                liveWindows.add(window);

            this._applyAppAlwaysOnTop(app, windows);
        }

        // Stop watching apps that no longer have any running windows.
        for (const [id, tracked] of this._windowChangedSignals) {
            if (!liveAppIds.has(id)) {
                try {
                    tracked.app.disconnect(tracked.signalId);
                } catch (e) {
                    console.error(`[custom-app-priority-switcher] could not disconnect ${id}: ${e}`);
                }
                this._windowChangedSignals.delete(id);
            }
        }

        // Drop references to windows that have already disappeared.
        for (const window of this._managedAboveWindows) {
            if (!liveWindows.has(window))
                this._managedAboveWindows.delete(window);
        }
    }

    _safeGetWindows(app) {
        try {
            return app.get_windows() ?? [];
        } catch (e) {
            console.error(`[custom-app-priority-switcher] could not get windows for ${app.get_id()}: ${e}`);
            return [];
        }
    }

    _applyAppAlwaysOnTop(app, knownWindows = null) {
        const shouldBeAbove = this._store.priority.has(app.get_id());
        const windows = knownWindows ?? this._safeGetWindows(app);

        for (const window of windows) {
            try {
                if (shouldBeAbove) {
                    // make_above() changes the stacking layer. It does not
                    // call activate(), so focus remains with whatever app
                    // the user is currently using.
                    if (!window.is_above()) {
                        window.make_above();
                        this._managedAboveWindows.add(window);
                    }
                } else if (this._managedAboveWindows.has(window)) {
                    window.unmake_above();
                    this._managedAboveWindows.delete(window);
                }
            } catch (e) {
                console.error(
                    `[custom-app-priority-switcher] could not update always-on-top for ${app.get_id()}: ${e}`);
            }
        }
    }

    _clearAlwaysOnTop() {
        for (const window of this._managedAboveWindows) {
            try {
                window.unmake_above();
            } catch (e) {
                // The window may have disappeared while the extension was
                // being disabled.
            }
        }
        this._managedAboveWindows.clear();
    }

    // ---- list building ---------------------------------------------------

    _onAppsChanged() {
        // This must run even when the popup is closed: priority is also a
        // window-stacking preference, not merely a list-sorting preference.
        this._syncAlwaysOnTop();

        if (!this.menu.isOpen)
            return;
        if (this._press?.dragging) {
            this._pendingRefresh = true;
            return;
        }
        this._refresh();
    }

    _refresh() {
        this._endPress();
        this._pendingRefresh = false;
        this._list.destroy_all_children();

        const apps = this._store.arrange(this._appSystem.get_running());

        if (apps.length === 0) {
            this._list.add_child(new St.Label({
                text: 'No running applications',
                style_class: 'cas-empty',
            }));
            return;
        }

        for (const app of apps)
            this._list.add_child(this._buildRow(app));
    }

    _buildRow(app) {
        const id = app.get_id();
        const isPriority = this._store.priority.has(id);

        const row = new St.BoxLayout({
            style_class: 'cas-row',
            reactive: true,
            track_hover: true,
            x_expand: true,
        });
        row._casId = id;
        row._casApp = app;
        row._casPriority = isPriority;

        // Priority circle
        const dot = new St.Button({
            style_class: isPriority ? 'cas-priority cas-priority-on' : 'cas-priority',
            reactive: true,
            can_focus: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: 'Toggle priority',
        });
        dot.connect('clicked', () => {
            this._store.togglePriority(id);
            this._syncAlwaysOnTop();
            this._refresh();
        });

        // Icon comes from the app's .desktop entry
        const icon = app.create_icon_texture(24);
        icon.y_align = Clutter.ActorAlign.CENTER;

        const label = new St.Label({
            text: app.get_name(),
            style_class: 'cas-name',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        // Only this middle area is interactive. The row itself is non-reactive,
        // so the priority/close buttons can never accidentally start a row
        // click/drag gesture or activate the application.
        const dragArea = new St.BoxLayout({
            style_class: 'cas-drag-area',
            reactive: true,
            track_hover: true,
            x_expand: true,
            y_expand: true,
        });
        dragArea.add_child(icon);
        dragArea.add_child(label);

        // Close: ask the app to quit; the row disappears when it really exits
        const close = new St.Button({
            style_class: 'cas-close',
            reactive: true,
            can_focus: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: 'Close application',
            child: new St.Icon({
                icon_name: 'window-close-symbolic',
                style_class: 'popup-menu-icon',
            }),
        });
        close.connect('clicked', () => app.request_quit());

        row.add_child(dot);
        row.add_child(dragArea);
        row.add_child(close);

        // The middle area handles activate-vs-drag. Because it is a sibling
        // of the two buttons, their clicks are completely independent.
        dragArea.connect('button-press-event', (_actor, event) => this._onRowPress(row, event));

        return row;
    }

    // ---- click vs. drag --------------------------------------------------

    _onRowPress(row, event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;

        this._endPress();
        const [x, y] = event.get_coords();
        this._press = {
            row,
            x,
            y,
            dragging: false,
            captureId: this.menu.actor.connect(
                'captured-event', (_actor, ev) => this._onCaptured(ev)),
        };
        return Clutter.EVENT_STOP;
    }

    _onCaptured(event) {
        const press = this._press;
        if (!press)
            return Clutter.EVENT_PROPAGATE;

        switch (event.type()) {
        case Clutter.EventType.MOTION:
            return this._onMotion(press, event);
        case Clutter.EventType.BUTTON_RELEASE:
            return this._onRelease(press);
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }

    _onMotion(press, event) {
        const [x, y] = event.get_coords();

        if (!press.dragging) {
            if (Math.hypot(x - press.x, y - press.y) < DRAG_THRESHOLD)
                return Clutter.EVENT_STOP;
            press.dragging = true;
            press.row.add_style_class_name('cas-row-dragging');
        }

        this._moveDraggedRow(press.row, x, y);
        return Clutter.EVENT_STOP;
    }

    /**
     * Live-reorder: the dragged row jumps to wherever the pointer is.
     * Priority rows can only move inside the priority block and normal rows
     * inside the normal block (priority is toggled with the circle).
     */
    _moveDraggedRow(row, stageX, stageY) {
        const [ok, , listY] = this._list.transform_stage_point(stageX, stageY);
        if (!ok)
            return;

        const rows = this._list.get_children();
        let target = 0;
        for (const other of rows) {
            if (other === row)
                continue;
            const box = other.get_allocation_box();
            if ((box.y1 + box.y2) / 2 < listY)
                target++;
        }

        const priCount = rows.filter(r => r._casPriority).length;
        if (row._casPriority)
            target = Math.min(target, priCount - 1);
        else
            target = Math.max(target, priCount);
        target = Math.max(0, Math.min(target, rows.length - 1));

        if (rows.indexOf(row) !== target)
            this._list.set_child_at_index(row, target);
    }

    _onRelease(press) {
        const row = press.row;
        const wasDragging = press.dragging;
        this._endPress();

        if (wasDragging) {
            const ids = this._list.get_children().map(r => r._casId);
            this._store.applyDisplayedOrder(ids);
            this._refresh();
        } else {
            this._activateApp(row._casApp);
        }
        return Clutter.EVENT_STOP;
    }

    _endPress() {
        const press = this._press;
        if (!press)
            return;
        this._press = null;
        this.menu.actor.disconnect(press.captureId);
        press.row.remove_style_class_name('cas-row-dragging');
    }

    _activateApp(app) {
        this.menu.close();
        app.activate();
    }
});

export default class CustomAppPrioritySwitcher extends Extension {
    enable() {
        const path = GLib.build_filenamev([
            GLib.get_user_config_dir(),
            'custom-app-priority-switcher',
            'state.json',
        ]);
        this._store = new StateStore(path);
        this._indicator = new AppSwitcherButton(this._store);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this._store = null;
    }
}
