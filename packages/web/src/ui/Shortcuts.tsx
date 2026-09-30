/**
 * Keyboard reference.
 *
 * Bindings follow Figma, which is where this tool's users arrive from — so the
 * most useful thing the sheet does is confirm that the shortcut already in
 * someone's fingers works here too.
 */
import { Modal } from './Modal.tsx';

const GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: 'Tools',
    items: [
      ['V', 'Move'], ['H', 'Pan'], ['F', 'Frame'], ['T', 'Text'],
      ['R', 'Rectangle'], ['O', 'Ellipse'], ['I', 'Image'], ['N', 'Prompt card'],
      ['C', 'Comment'],
      ['D', 'Diamond, for a diagram'], ['X', 'Connector'], ['⇧S', 'Section'],
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
      ['⌘A', 'Select frame contents'],
      ['Tab / ⇧Tab', 'Next / previous sibling'],
      ['\\', 'Select parent'],
      ['Esc', 'Select parent — or leave the tool, or stop editing'],
      ['Enter', 'Edit text, or select children'],
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
      ['⌘/Ctrl + Arrows', 'Move one place along inside the parent'],
      ['F2', 'Rename the selected layer'],
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
      ['1 or ⇧1', 'Zoom to fit'],
      ['2 or ⇧2', 'Zoom to selection'],
      ['+ / −', 'Zoom in / out'],
      ['⇧0', 'Zoom to 100%'],
      ['⌘ Scroll', 'Zoom at the cursor'],
      ['P', 'Present this page'],
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
    <Modal title={'Keyboard shortcuts'} wide onClose={onClose}>
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
    </Modal>
  );
}
