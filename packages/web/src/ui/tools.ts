/**
 * What each tool is called, everywhere it is named.
 *
 * The toolbar, the palette and the shortcuts sheet each had their own list, and
 * they had drifted: the palette said "Diamond — for a diagram" where the toolbar
 * said "Diamond", and two tools were missing from it altogether. One table.
 */

import type { Tool } from '../state/store.ts';
import type { IconName } from './Icon.tsx';

export interface ToolInfo { tool: Tool; icon: IconName; key: string; name: string; title: string }

export const TOOLS: Record<Tool, ToolInfo> = {
  move: { tool: 'move', icon: 'cursor', key: 'V', name: 'Move', title: 'Move' },
  hand: { tool: 'hand', icon: 'hand', key: 'H', name: 'Pan', title: 'Pan' },
  frame: { tool: 'frame', icon: 'frame', key: 'F', name: 'Frame', title: 'Frame' },
  section: { tool: 'section', icon: 'section', key: '⇧S', name: 'Section', title: 'Section — gather part of a diagram, or a set of screens' },
  text: { tool: 'text', icon: 'text', key: 'T', name: 'Text', title: 'Text' },
  rect: { tool: 'rect', icon: 'square', key: 'R', name: 'Rectangle', title: 'Rectangle' },
  ellipse: { tool: 'ellipse', icon: 'circle', key: 'O', name: 'Ellipse', title: 'Ellipse' },
  diamond: { tool: 'diamond', icon: 'diamond', key: 'D', name: 'Diamond', title: 'Diamond — a decision in a diagram' },
  image: { tool: 'image', icon: 'image', key: 'I', name: 'Image', title: 'Image' },
  connector: { tool: 'connector', icon: 'connector', key: 'X', name: 'Connector', title: 'Connector — drag from one thing to another' },
  note: { tool: 'note', icon: 'note', key: 'N', name: 'Prompt card', title: 'Prompt card — leave a note or ask an agent' },
  comment: { tool: 'comment', icon: 'comment', key: 'C', name: 'Comment', title: 'Comment — say something about the design' },
};

/** The order tools are listed in when they are listed. */
export const TOOL_ORDER: Tool[] = [
  'move', 'hand', 'frame', 'section', 'rect', 'ellipse', 'diamond', 'image', 'text', 'connector', 'note', 'comment',
];

/** The modifier key the reader actually has, for tooltips and menus. */
export const MOD = typeof navigator !== 'undefined' && /Mac|iP(hone|ad)/.test(navigator.platform) ? '⌘' : 'Ctrl+';
