import { useState, type ReactNode } from 'react';

/**
 * A <details> whose body exists only while it is open. Closed, it holds nothing
 * but its summary: a long conversation keeps its folded steps, tool output and
 * raw payloads out of the page, so styling, layout and the browser's own text
 * searches (caret placement, macOS Look Up) stay cheap.
 */
export function Disclosure({ className, summary, children }: { className?: string; summary: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <details className={className} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{summary}</summary>
    {open && children}
  </details>;
}
