/**
 * A scrollable region with no scrollbar furniture.
 *
 * The scrollbar is hidden, so a soft fade at the bottom is the only cue that
 * content continues — and it has to disappear at the end of the list, or the
 * last row always looks half-faded and unfinished.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

interface Props {
  children: React.ReactNode;
  className?: string;
}

export function ScrollArea({ children, className }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [atEnd, setAtEnd] = useState(true);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAtEnd(remaining < 4);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    // Content height changes as panels expand, not only as the user scrolls.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [measure, children]);

  return (
    <div
      ref={ref}
      className={`scroll-area${atEnd ? ' is-at-end' : ''}${className ? ` ${className}` : ''}`}
      onScroll={measure}
    >
      {children}
    </div>
  );
}
