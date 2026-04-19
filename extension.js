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
import Graphene from 'gi://Graphene';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { WorkspaceBackground } from 'resource:///org/gnome/shell/ui/workspace.js';

export default class SmoothOverviewExtension extends Extension {
    enable() {
        console.log(`[Smooth Overview] Enabling extension and patching WorkspaceBackground...`);

        // 1. Save the original method
        this._originalUpdateBounds = WorkspaceBackground.prototype._updateRoundedClipBounds;

        // 2. Inject our hijacked method
        WorkspaceBackground.prototype._updateRoundedClipBounds = function() {
            const monitor = Main.layoutManager.monitors[this._monitorIndex];
            const rect = new Graphene.Rect();

            // Force the background clip to the absolute bounds of the monitor.
            rect.origin.x = 0;
            rect.origin.y = 0;
            rect.size.width = monitor.width;
            rect.size.height = monitor.height;

            // Apply the un-clipped geometry
            this._bgManager.backgroundActor.content.set_rounded_clip_bounds(rect);
        };
    }

    disable() {
        console.log(`[Smooth Overview] Disabling extension and restoring original behavior...`);

        // 3. Put the original method back
        if (this._originalUpdateBounds) {
            WorkspaceBackground.prototype._updateRoundedClipBounds = this._originalUpdateBounds;
            this._originalUpdateBounds = null;
        }
    }
}
