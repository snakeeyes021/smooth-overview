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
 * the extension is always on. It all follows live: changing the setting,
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
        this._stateId = Main.extensionManager.connect('extension-state-changed',
            (_manager, extension) => {
                if (DOCKS.includes(extension.uuid))
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
        this._settings = null;
        this._unwatchDockSettings();
        this._setActive(false);
    }

    // Find the running dock, if any, and follow its panel-mode setting.
    _watchDock() {
        const dock = DOCKS.map(uuid => Main.extensionManager.lookup(uuid))
            .find(extension => extension?.state === ACTIVE);
        if (dock?.uuid !== this._dockUuid) {
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
        const followDock = this._settings.get_boolean('follow-dash-to-dock') &&
            Boolean(this._dockSettings);
        this._setActive(!followDock || !this._dockSettings.get_boolean('extend-height'));
    }

    _setActive(active) {
        if (active === Boolean(this._injections))
            return;
        if (active) {
            this._injections = new InjectionManager();
            this._injections.overrideMethod(Layout.LayoutManager.prototype, 'getWorkAreaForMonitor',
                original => function (monitorIndex) {
                    const workArea = original.call(this, monitorIndex);
                    if (!calledFromOverview())
                        return workArea;
                    return overviewArea(monitorIndex) ?? workArea;
                });
        } else {
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
