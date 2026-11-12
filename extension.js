/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Mtk from 'gi://Mtk';

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// The overview sizes its workspaces and their backgrounds from the monitor's
// work area, which a fixed dock shrinks, and the top bar centres its clock
// on the work area too. These are the files whose work area lookups get the
// monitor minus the top bar instead, so the overview fills the screen behind
// the dock and the clock stays in the middle of the screen. Everything else
// (window placement, maximizing, popups, the dock itself) keeps the real
// work area.
const OVERVIEW_CALLERS = [
    'resource:///org/gnome/shell/ui/workspace.js:',
    'resource:///org/gnome/shell/ui/overviewControls.js:',
    'resource:///org/gnome/shell/ui/panel.js:',
];

// Dash to Dock adjusts the overview's layout for the dock in closures
// inside its _prepareMainDash() (it moves the search entry over by the
// dock's width, for one). Those count as overview callers too, so the
// overview stays centred on the screen. Dash to Dock's other lookups (where
// to put the dock itself) are left alone.
const DASH_TO_DOCK_FILE = '/dash-to-dock@micxgx.gmail.com/docking.js:';
const DASH_TO_DOCK_OVERVIEW_FUNCTIONS = [
    '_prepareMainDash',
    'maybeAdjustBoxSize',
    'maybeAdjustBoxToDock',
    'maybeLimitWorkspaceBoxSize',
];

/**
 * Whether the function that called getWorkAreaForMonitor() is part of the
 * overview or the top bar. Only the direct caller counts: code that merely
 * runs while the overview is on the stack (a popup, another extension) is
 * left alone.
 *
 * @returns {boolean}
 */
function calledFromOverview() {
    // Frame 0 is this function, frame 1 our override, frame 2 the caller,
    // written "functionName@file:line:column".
    const caller = new Error().stack.split('\n')[2] ?? '';
    if (OVERVIEW_CALLERS.some(file => caller.includes(file)))
        return true;

    if (!caller.includes(DASH_TO_DOCK_FILE))
        return false;
    const name = caller.slice(0, caller.indexOf('@'));
    return DASH_TO_DOCK_OVERVIEW_FUNCTIONS.some(fn => name === fn || name.startsWith(`${fn}/`));
}

// Tiling Shell builds its tiles from the work area. While a maximized window
// may cover a floating dock (see maximize-over-floating-dock), the dock
// reserves no space, so Tiling Shell's lookups get the area beside the dock
// instead: the area its tiles had before, so tiling doesn't change.
const TILING_SHELL_DIR = '/tilingshell@ferrarodomenico.com/';

/**
 * Whether the function that called getWorkAreaForMonitor() is Tiling Shell's.
 *
 * @returns {boolean}
 */
function calledFromTilingShell() {
    const caller = new Error().stack.split('\n')[2] ?? '';
    return caller.includes(TILING_SHELL_DIR);
}

/**
 * Dash to Dock's docks (one per monitor it shows on).
 *
 * @returns {object[]}
 */
function docks() {
    return Main.layoutManager.uiGroup.get_children()
        .filter(actor => actor.name === 'dashtodockContainer' && actor._staticBox);
}

/**
 * The work area as it would be if the monitor's docks reserved their space:
 * each dock's box (with the gap around it) taken off its side.
 *
 * @param {number} monitorIndex
 * @param {Mtk.Rectangle} workArea
 * @returns {Mtk.Rectangle}
 */
function areaBesideDocks(monitorIndex, workArea) {
    let x1 = workArea.x, y1 = workArea.y;
    let x2 = workArea.x + workArea.width, y2 = workArea.y + workArea.height;
    for (const dock of docks()) {
        if (dock.monitorIndex !== monitorIndex)
            continue;
        const box = dock._staticBox;
        switch (dock._position) {
        case St.Side.LEFT:
            x1 = Math.max(x1, Math.round(box.x2));
            break;
        case St.Side.RIGHT:
            x2 = Math.min(x2, Math.round(box.x1));
            break;
        case St.Side.TOP:
            y1 = Math.max(y1, Math.round(box.y2));
            break;
        case St.Side.BOTTOM:
            y2 = Math.min(y2, Math.round(box.y1));
            break;
        }
    }
    return new Mtk.Rectangle({x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1)});
}

// The Dash to Dock settings maximize-over-floating-dock takes over while the
// dock floats: the dock reserves no space (so a maximized window fills the
// screen below the top bar), hides while a maximized window overlaps it,
// and comes back when the pointer is pushed against its edge. The user's own
// values are kept in saved-dock-settings and put back afterwards.
const DOCK_TAKEOVER = {
    'dock-fixed': new GLib.Variant('b', false),
    'intellihide': new GLib.Variant('b', true),
    'intellihide-mode': new GLib.Variant('s', 'MAXIMIZED_WINDOWS'),
    'autohide': new GLib.Variant('b', true),
};

/**
 * The monitor's area minus the top bar, ignoring any other struts (docks).
 *
 * @param {number} monitorIndex
 * @returns {Mtk.Rectangle|null}
 */
function overviewArea(monitorIndex) {
    const {layoutManager} = Main;
    const monitor = layoutManager.monitors[monitorIndex];
    if (!monitor)
        return null;

    let {x, y, width, height} = monitor;
    const {panelBox} = layoutManager;
    if (monitorIndex === layoutManager.primaryIndex && panelBox.visible) {
        const panelHeight = panelBox.height;
        if (panelBox.y <= monitor.y) {
            y += panelHeight;
            height -= panelHeight;
        } else if (panelBox.y + panelHeight >= monitor.y + monitor.height) {
            height -= panelHeight;
        }
    }
    return new Mtk.Rectangle({x, y, width, height});
}

// The docks whose settings say whether the dock reaches the screen edges.
// Ubuntu Dock is a fork of Dash to Dock with the same settings schema.
const DOCKS = ['dash-to-dock@micxgx.gmail.com', 'ubuntu-dock@ubuntu.com'];
const DOCK_SCHEMA = 'org.gnome.shell.extensions.dash-to-dock';
const ACTIVE = ExtensionState.ACTIVE ?? ExtensionState.ENABLED;

// Dash to Panel replaces the top bar with its own taskbar, which always
// reserves its screen edge. GNOME's overview already fits that exactly, and
// the overview's wallpaper is scaled for the real work area, so Smooth
// Overview steps aside while it runs (otherwise the wallpaper sits a
// taskbar's height off while the overview opens and closes, then jumps).
const PANELS = ['dash-to-panel@jderose9.github.com'];

/**
 * Dash to Dock's settings, from its own schemas folder or the system's.
 *
 * @param {object} dock the dock's extension object
 * @returns {Gio.Settings|null}
 */
function dockSettings(dock) {
    const dir = dock.dir?.get_child('schemas');
    const parent = Gio.SettingsSchemaSource.get_default();
    let source = parent;
    if (dir?.query_exists(null))
        source = Gio.SettingsSchemaSource.new_from_directory(dir.get_path(), parent, false);
    const schema = source?.lookup(DOCK_SCHEMA, true);
    return schema ? new Gio.Settings({settings_schema: schema}) : null;
}

/*
 * The follow-dash-to-dock setting is on by default. With it on, the
 * extension only fills in the overview behind a dock that stops short
 * of the screen's edges (a floating or centred dock): a dock that runs edge
 * to edge (Dash to Dock's "panel mode", extend-height) already looks right
 * with GNOME's own overview, so the extension stays out of the way then.
 * With the setting off, or when no dock is running (nothing to follow),
 * the extension is always on. Either way, it steps aside while Dash to
 * Panel runs (see PANELS). It all follows live: changing the setting,
 * turning the dock on or off, or changing its panel mode takes effect at
 * once.
 */
export default class SmoothOverviewExtension extends Extension {
    // GNOME Shell can call enable() or disable() twice in a row when the
    // enabled-extensions list changes quickly (each change is handled
    // asynchronously), so both are written to be safe to repeat.
    enable() {
        if (this._stateId)
            return;
        this._settings = this.getSettings();
        this._followId = this._settings.connect('changed::follow-dash-to-dock',
            () => this._update());
        this._maximizeId = this._settings.connect('changed::maximize-over-floating-dock',
            () => this._update());
        this._stateId = Main.extensionManager.connect('extension-state-changed',
            (_manager, extension) => {
                if (DOCKS.includes(extension.uuid) || PANELS.includes(extension.uuid))
                    this._watchDock();
            });
        this._watchDock();
    }

    disable() {
        if (!this._stateId)
            return;
        Main.extensionManager.disconnect(this._stateId);
        this._stateId = 0;
        this._settings.disconnect(this._followId);
        this._followId = 0;
        this._settings.disconnect(this._maximizeId);
        this._maximizeId = 0;
        this._setTakeover(false);
        this._unwatchDockSettings();
        this._setActive(false);
        this._settings = null;
    }

    // Find the running dock, if any, and follow its panel-mode setting.
    _watchDock() {
        const dock = DOCKS.map(uuid => Main.extensionManager.lookup(uuid))
            .find(extension => extension?.state === ACTIVE);
        if (dock?.uuid !== this._dockUuid) {
            // Give the old dock its own settings back before letting go of it.
            this._setTakeover(false);
            this._unwatchDockSettings();
            this._dockUuid = dock?.uuid ?? null;
            this._dockSettings = dock ? dockSettings(dock) : null;
            this._dockSettingsId = this._dockSettings?.connect('changed::extend-height',
                () => this._update()) ?? 0;
        }
        this._update();
    }

    _unwatchDockSettings() {
        if (this._dockSettingsId)
            this._dockSettings.disconnect(this._dockSettingsId);
        this._dockSettingsId = 0;
        this._dockSettings = null;
        this._dockUuid = null;
    }

    _update() {
        if (PANELS.some(uuid => Main.extensionManager.lookup(uuid)?.state === ACTIVE)) {
            this._setTakeover(false);
            this._setActive(false);
            return;
        }
        const floating = Boolean(this._dockSettings) &&
            !this._dockSettings.get_boolean('extend-height');
        const followDock = this._settings.get_boolean('follow-dash-to-dock') &&
            Boolean(this._dockSettings);
        this._setActive(!followDock || floating);
        this._setTakeover(floating && this._settings.get_boolean('maximize-over-floating-dock'));
    }

    // maximize-over-floating-dock: while the dock floats, take over the Dash
    // to Dock settings in DOCK_TAKEOVER, keeping the user's own values to put
    // back. Anything else that changes them meanwhile (the dock's own
    // preferences, a layout switcher) becomes the value put back afterwards.
    _setTakeover(on) {
        const dockSettings = this._dockSettings;
        if (on && dockSettings) {
            if (this._takeoverIds)
                return;
            const saved = this._savedDockSettings();
            if (!saved) {
                const values = {};
                for (const key of Object.keys(DOCK_TAKEOVER))
                    values[key] = dockSettings.get_user_value(key)?.print(true) ?? null;
                this._settings.set_string('saved-dock-settings', JSON.stringify(values));
            }
            this._takeoverIds = Object.keys(DOCK_TAKEOVER).map(key =>
                dockSettings.connect(`changed::${key}`, () => this._dockSettingChanged(key)));
            this._watchDockBoxes(true);
            this._applyTakeover();
        } else {
            if (this._takeoverIds) {
                this._takeoverIds.forEach(id => this._takeoverSettings.disconnect(id));
                this._takeoverIds = null;
            }
            this._watchDockBoxes(false);
            this._keepDocksStyled(false);
            if (this._takeoverIdle) {
                GLib.source_remove(this._takeoverIdle);
                this._takeoverIdle = 0;
            }
            const saved = this._savedDockSettings();
            if (saved && dockSettings) {
                this._writingTakeover = true;
                for (const [key, text] of Object.entries(saved)) {
                    if (text === null)
                        dockSettings.reset(key);
                    else
                        dockSettings.set_value(key, GLib.Variant.parse(null, text, null, null));
                }
                this._writingTakeover = false;
                this._settings.set_string('saved-dock-settings', '');
            }
        }
        this._takeoverSettings = this._takeoverIds ? dockSettings : null;
    }

    _savedDockSettings() {
        const text = this._settings?.get_string('saved-dock-settings');
        if (!text)
            return null;
        try {
            return JSON.parse(text);
        } catch (e) {
            return null;
        }
    }

    _applyTakeover() {
        this._writingTakeover = true;
        for (const [key, value] of Object.entries(DOCK_TAKEOVER)) {
            if (!this._dockSettings.get_value(key).equal(value))
                this._dockSettings.set_value(key, value);
        }
        this._writingTakeover = false;
    }

    _dockSettingChanged(key) {
        if (this._writingTakeover || !this._takeoverIds)
            return;
        const value = this._dockSettings.get_value(key);
        if (value.equal(DOCK_TAKEOVER[key]))
            return;
        // Someone else set it: keep their value to put back later, and take
        // the setting over again once they're done.
        const saved = this._savedDockSettings() ?? {};
        saved[key] = this._dockSettings.get_user_value(key)?.print(true) ?? null;
        this._settings.set_string('saved-dock-settings', JSON.stringify(saved));
        if (!this._takeoverIdle) {
            this._takeoverIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._takeoverIdle = 0;
                if (this._takeoverIds)
                    this._applyTakeover();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    // Dash to Dock styles a dock that reserves its space ("fixed") a little
    // differently: a small margin on the side facing the windows. Keep that
    // style while the dock is taken over, so it looks and measures exactly
    // as before (and Tiling Shell's area beside it doesn't move by a pixel).
    _keepDocksStyled(on, dock = null) {
        if (!on) {
            if (this._dockInjections) {
                this._dockInjections.clear();
                this._dockInjections = null;
                docks().forEach(d => d._resetPosition?.());
            }
            return;
        }
        if (this._dockInjections || !dock?._resetPosition)
            return;
        this._dockInjections = new InjectionManager();
        const extension = this;
        this._dockInjections.overrideMethod(Object.getPrototypeOf(dock), '_resetPosition',
            original => function (...args) {
                original.call(this, ...args);
                if (extension._takeoverIds)
                    this.add_style_class_name('fixed');
            });
        docks().forEach(d => d._resetPosition());
    }

    // While the dock reserves no space, nothing tells Tiling Shell when the
    // dock's size or place changes (icons shrinking as apps are added, the
    // dock moving to another side), so announce new work areas then.
    _watchDockBoxes(on) {
        if (!on) {
            if (this._uiGroupId)
                Main.layoutManager.uiGroup.disconnect(this._uiGroupId);
            this._uiGroupId = 0;
            for (const [dock, id] of this._dockBoxIds ?? [])
                dock.disconnect(id);
            this._dockBoxIds = null;
            this._dockBoxes = null;
            return;
        }
        if (this._dockBoxIds)
            return;
        this._dockBoxIds = new Map();
        const watch = dock => {
            this._keepDocksStyled(true, dock);
            if (this._dockBoxIds.has(dock))
                return;
            this._dockBoxIds.set(dock, dock.connect('notify::allocation', () => this._dockBoxesMoved()));
            dock.connect('destroy', () => this._dockBoxIds?.delete(dock));
        };
        docks().forEach(watch);
        this._uiGroupId = Main.layoutManager.uiGroup.connect('child-added', (_group, actor) => {
            if (actor.name === 'dashtodockContainer')
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    if (this._dockBoxIds && actor._staticBox)
                        watch(actor);
                    this._dockBoxesMoved();
                    return GLib.SOURCE_REMOVE;
                });
        });
        this._dockBoxesMoved();
    }

    _dockBoxesMoved() {
        const boxes = docks().map(dock => {
            const box = dock._staticBox;
            return `${dock.monitorIndex}:${dock._position}:${box.x1},${box.y1},${box.x2},${box.y2}`;
        }).join(' ');
        if (boxes === this._dockBoxes)
            return;
        this._dockBoxes = boxes;
        this._refresh();
    }

    _setActive(active) {
        if (active === Boolean(this._injections))
            return;
        if (active) {
            this._injections = new InjectionManager();
            const extension = this;
            this._injections.overrideMethod(Layout.LayoutManager.prototype, 'getWorkAreaForMonitor',
                original => function (monitorIndex) {
                    const workArea = original.call(this, monitorIndex);
                    if (calledFromOverview())
                        return overviewArea(monitorIndex) ?? workArea;
                    if (extension._takeoverIds && calledFromTilingShell())
                        return areaBesideDocks(monitorIndex, workArea);
                    return workArea;
                });
            // When a monitor is plugged in or out, GNOME can announce the new
            // work areas before its own list of monitors (which our area is
            // worked out from) is updated, so the overview would keep areas
            // for the old monitors. Have it read them again once the list
            // is up to date.
            this._monitorsId = Main.layoutManager.connect('monitors-changed',
                () => this._refresh());
        } else {
            Main.layoutManager.disconnect(this._monitorsId);
            this._monitorsId = 0;
            this._injections.clear();
            this._injections = null;
        }
        this._refresh();
    }

    // The overview and the top bar cache the work area and only re-read it
    // when the work areas change, so tell them they did. This is what makes enabling and
    // disabling take effect without logging out.
    _refresh() {
        global.display.emit('workareas-changed');
    }
}
