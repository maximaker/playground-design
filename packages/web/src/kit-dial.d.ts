// Types for the vendored kit/dial/dial.js (kept byte-identical to the kit).
export interface DialItem {
  id: string; label: string; icon?: string; kbd?: string; badge?: boolean | string; panel?: boolean;
}
export interface DialRow {
  id: string; label: string; meta?: string; emoji?: string; swatch?: boolean | string;
  current?: boolean; tree?: boolean; open?: boolean; children?: DialRow[]; href?: string; icon?: string | false;
}
export interface DialPanel {
  title?: string; filter?: string;
  groups: { title?: string; rows: DialRow[]; empty?: string }[];
}
export interface DialOptions {
  app?: string; name?: string; label?: string; mark?: string;
  items?: DialItem[]; activeId?: string | null; panel?: DialPanel | null;
  onSelect?: (item: DialItem) => void; onRow?: (row: DialRow) => void;
  startClosed?: boolean; corner?: boolean; mount?: HTMLElement;
  onMoveTo?: (row: DialRow) => void;
}
export interface Dial {
  el: HTMLElement;
  update(next: Partial<DialOptions>): void;
  setOpen(open: boolean): void; isOpen(): boolean;
  openPanel(): void; closePanel(): void;
  readonly pinned: boolean; setPinned(on: boolean): void;
  readonly compact: boolean; openDrawer(): void; closeDrawer(): void;
  destroy(): void;
}
export function createDial(opts: DialOptions): Dial;
export const DIAL_ICONS: Record<string, string>;
export const COMPACT_QUERY: string;
export function isCompact(): boolean;
export function miniRingAllowed(pointerType?: string): boolean;
export function drawerHint(item: DialItem): string;
