/* prefs.js
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

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// The same docks extension.js follows. Ubuntu Dock is a fork of Dash to
// Dock with the same settings.
const DOCKS = ['dash-to-dock@micxgx.gmail.com', 'ubuntu-dock@ubuntu.com'];

// Preferences run in their own process, so they ask GNOME Shell over D-Bus
// whether a dock is running.
const SHELL_NAME = 'org.gnome.Shell.Extensions';
const SHELL_PATH = '/org/gnome/Shell/Extensions';
const SHELL_IFACE = 'org.gnome.Shell.Extensions';
// ExtensionState.ACTIVE (ENABLED before GNOME 49 renamed it).
const STATE_ACTIVE = 1;

const FOLLOW_SUBTITLE = "Follows Dash to Dock: on when the dock doesn't reach the screen edges";
const NO_DOCK_SUBTITLE = "Needs Dash to Dock, which isn't turned on. Until then this is always on";

export default class SmoothOverviewPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;

        const row = new Adw.SwitchRow({
            title: 'Only when the dock is floating',
            subtitle: FOLLOW_SUBTITLE,
        });
        settings.bind('follow-dash-to-dock', row, 'active', Gio.SettingsBindFlags.DEFAULT);

        const group = new Adw.PreferencesGroup();
        group.add(row);
        const page = new Adw.PreferencesPage();
        page.add(group);
        window.add(page);

        // Grey the switch out while no dock is running, and follow docks
        // being turned on or off while the window is open.
        const running = new Set();
        const show = () => {
            const available = running.size > 0;
            row.sensitive = available;
            row.subtitle = available ? FOLLOW_SUBTITLE : NO_DOCK_SUBTITLE;
        };
        const note = (uuid, state) => {
            if (state?.state?.unpack() === STATE_ACTIVE)
                running.add(uuid);
            else
                running.delete(uuid);
            show();
        };

        const bus = Gio.DBus.session;
        const signalId = bus.signal_subscribe(SHELL_NAME, SHELL_IFACE,
            'ExtensionStateChanged', SHELL_PATH, null, Gio.DBusSignalFlags.NONE,
            (_bus, _sender, _path, _iface, _signal, params) => {
                const [uuid, state] = params.deepUnpack();
                if (DOCKS.includes(uuid))
                    note(uuid, state);
            });
        window.connect('close-request', () => {
            bus.signal_unsubscribe(signalId);
            return false;
        });

        show();
        for (const uuid of DOCKS) {
            bus.call(SHELL_NAME, SHELL_PATH, SHELL_IFACE, 'GetExtensionInfo',
                new GLib.Variant('(s)', [uuid]), new GLib.VariantType('(a{sv})'),
                Gio.DBusCallFlags.NONE, -1, null, (_bus, result) => {
                    try {
                        const [info] = bus.call_finish(result).deepUnpack();
                        note(uuid, info);
                    } catch (e) {
                        logError(e, `Smooth Overview: couldn't look up ${uuid}`);
                    }
                });
        }
    }
}
