import type { TerminalPerformanceProbe } from "./terminal-performance";

export interface XtermProbe {
  cols: number;
  rows: number;
  sseMessages: number;
  bytesWritten: number;
  lastOffset?: number;
  lastReset?: boolean;
  gaps?: number;
  /**
   * Bytes the server reported as unrecoverable on replay. Distinct from `gaps`,
   * which a resync can still repair — a non-zero `dropped` means this card's
   * scrollback genuinely has a hole in it.
   */
  dropped?: number;
  status: string;
  performance?: ReturnType<TerminalPerformanceProbe["snapshot"]>;
  at: number;
}

const probes = new Map<string, XtermProbe>();

export function setXtermProbe(id: string, probe: Omit<XtermProbe, "at">) {
  probes.set(id, { ...probe, at: Date.now() });
}

export function getXtermProbe(id: string): XtermProbe | undefined {
  return probes.get(id);
}
