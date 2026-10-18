/**
 * What sits behind an artboard's own content: the sheet it is drawn on.
 *
 * Every frame used to sit on a white sheet, so a slide with rounded corners,
 * or one that was meant to be see-through, showed white corners on the canvas
 * and in the presentation. The artboard decides now: one with a fill of its
 * own (any background, transparent included) paints itself and the sheet is
 * clear; one with none keeps the white page it always had. A border-radius on
 * the artboard rounds the sheet, the frame and its shadow too.
 */
import type { CanvasNode } from '@playground/shared';

export interface Surface { sheet: string; radius?: string; clear: boolean }

export function artboardSurface(node: CanvasNode | undefined): Surface {
  const s = node?.styles ?? {};
  const own = s['background-color'] ?? s.background ?? s['background-image'];
  const clear = own !== undefined && own !== '';
  const radius = s['border-radius'] || undefined;
  return { sheet: clear ? 'transparent' : '#fff', radius, clear };
}
