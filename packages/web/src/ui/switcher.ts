/*
 * Closes any open app switcher (<details class="hm-switcher">) on Escape or a
 * click outside it, which <details> does not do on its own. Call once at
 * startup; safe to call again. Framework-agnostic.
 */
export function wireSwitcher(doc: Document & { __hmSwitcherWired?: boolean } = document): void {
  if (doc.__hmSwitcherWired) return;
  doc.__hmSwitcherWired = true;
  const closeAll = (except: Element | null) => {
    doc.querySelectorAll('details.hm-switcher[open]').forEach((d) => {
      if (d !== except) d.removeAttribute('open');
    });
  };
  doc.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    const open = doc.querySelector('details.hm-switcher[open]');
    if (!open) return;
    open.removeAttribute('open');
    open.querySelector<HTMLElement>('summary')?.focus();
  });
  doc.addEventListener('pointerdown', (e: PointerEvent) => {
    const inside = e.target instanceof Element ? e.target.closest('details.hm-switcher') : null;
    closeAll(inside);
  });
}
