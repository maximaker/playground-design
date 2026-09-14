/**
 * Keyboard reference.
 *
 * Bindings follow Figma, which is where this tool's users arrive from — so the
 * most useful thing the sheet does is confirm that the shortcut already in
 * someone's fingers works here too.
 */
import { Icon } from './Icon.tsx';

const GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: 'Tools',
    items: [
      ['V', 'Move'], ['H', 'Pan'], ['F', 'Frame'], ['T', 'Text'],
      ['R', 'Rectangle'], ['O', 'Ellipse'], ['I', 'Image'], ['N', 'Prompt card'],
      ['Space + drag', 'Pan from any tool'],
    ],
  },
  {
    title: 'Everything',
    items: [
      ['⌘K', 'Search layers, run any command'],
      ['?', 'This sheet'],
    ],
  },
  {
    title: 'Selection',
    items: [
      ['Click', 'Select the outermost layer'],
      ['⌘ Click', 'Select the deepest layer, or a part inside a component'],
      ['Shift Click', 'Add to selection'],
      ['⌘A', 'Select artboard contents'],
      ['Tab / ⇧Tab', 'Next / previous sibling'],
      ['Esc', 'Select parent'],
      ['Enter', 'Edit text, or select children'],
      ['\\\\', 'Select parent'],
    ],
  },
  {
    title: 'Edit',
    items: [
      ['⌘Z / ⌘⇧Z', 'Undo / redo'],
      ['⌘D', 'Duplicate'],
      ['⌘G / ⌘⇧G', 'Wrap in frame / unwrap'],
      ['⌥⌘C / ⌥⌘V', 'Copy / paste properties'],
      ['⌘⇧C', 'Copy as CSS'],
      ['⌘C / ⌘V', 'Copy / paste as HTML'],
      ['⌫', 'Delete'],
      ['Arrows', 'Nudge 1px (⇧ for 10px)'],
    ],
  },
  {
    title: 'Arrange',
    items: [
      ['] / [', 'Bring to front / send to back'],
      ['⌘] / ⌘[', 'Bring forward / send backward'],
      ['⌘⇧H', 'Hide or show'],
      ['⌘⇧L', 'Lock or unlock'],
    ],
  },
  {
    title: 'View',
    items: [
      ['1', 'Zoom to fit'],
      ['2', 'Zoom to selection'],
      ['⌘0', 'Zoom to 100%'],
      ['⌘+ / ⌘−', 'Zoom in / out'],
      ['⌘ Scroll', 'Zoom at the cursor'],
      ['⌘⇧E', 'Export'],
    ],
  },
  {
    title: 'While dragging',
    items: [
      ['⌘', 'Suspend snapping'],
      ['⌥ hover', 'Measure distance to the hovered layer'],
      ['⇧ resize', 'Keep the aspect ratio'],
      ['⌘ drop', 'Drop out of flex flow, positioned absolutely'],
    ],
  },
];

export function Shortcuts({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="modal is-wide" onPointerDown={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>Keyboard shortcuts</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close"><Icon name="close" size={14} /></button>
        </header>
        <div className="modal-body">
          <p className="modal-lede">
            These follow Figma wherever Figma has a binding, so most of what you already know works.
          </p>
          <div className="shortcut-grid">
            {GROUPS.map((group) => (
              <section key={group.title}>
                <h3>{group.title}</h3>
                {group.items.map(([keys, label]) => (
                  <div key={keys} className="shortcut-row">
                    <span>{label}</span>
                    <kbd>{keys}</kbd>
                  </div>
                ))}
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
