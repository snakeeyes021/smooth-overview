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
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

let originalGetWorkArea = null;

export default class SmoothOverviewExtension extends Extension {
    enable() {
        console.log(`[Smooth Overview] Injecting universal Overview workArea bypass...`);

        // 1. Save the original GNOME function
        originalGetWorkArea = Main.layoutManager.getWorkAreaForMonitor;

        // 2. Intercept the function
        Main.layoutManager.getWorkAreaForMonitor = function(monitorIndex) {
            let rect = originalGetWorkArea.call(this, monitorIndex);

            // 3. THE SNEAKY PART: Catch the static overview AND the slide animation
            const stack = new Error().stack;
            if (stack.includes('workspace.js') ||
                stack.includes('workspaceAnimation.js') ||
                stack.includes('overviewControls.js')) {

                rect = rect.copy();
                const monitor = this.monitors[monitorIndex];

                // 4. THE PANEL MATH: Check if this monitor has the top panel
                const isPrimary = (monitorIndex === Main.layoutManager.primaryIndex);
                const panelHeight = (isPrimary && Main.panel) ? Main.panel.height : 0;

                // Force all Overview math to use the monitor bounds MINUS the top panel
                rect.x = monitor.x;
                rect.y = monitor.y + panelHeight;
                rect.width = monitor.width;
                rect.height = monitor.height - panelHeight;
            }

            return rect;
        };

        // 5. THE FIX: Force GNOME to dump its layout cache and apply our new math instantly
        if (global && global.display) {
            global.display.emit('workareas-changed');
        }
    }

    disable() {
        console.log(`[Smooth Overview] Restoring original workArea behavior...`);

        // 6. Put everything back to normal
        if (originalGetWorkArea) {
            Main.layoutManager.getWorkAreaForMonitor = originalGetWorkArea;
            originalGetWorkArea = null;
        }

        // 7. THE FIX: Force GNOME to dump its layout cache and revert to standard math
        if (global && global.display) {
            global.display.emit('workareas-changed');
        }
    }
}
