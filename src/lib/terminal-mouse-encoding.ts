import type { Terminal } from "@xterm/xterm";

/** SerializeAddon preserves mouse tracking, but omits its wire encoding. */
export function trackTerminalMouseEncoding(terminal: Terminal) {
  let encoding: 0 | 1006 | 1016 = 0;
  const observe = (params: (number | number[])[], enabled: boolean) => {
    for (const param of params) {
      // Arrays contain colon subparameters, which xterm ignores for DECSET.
      if (Array.isArray(param)) continue;
      const mode = param;
      if (mode === 1006 || mode === 1016) encoding = enabled ? mode : 0;
    }
    return false; // Let xterm apply the sequence too.
  };
  const handlers = [
    terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, params => observe(params, true)),
    terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, params => observe(params, false)),
    terminal.parser.registerEscHandler({ final: "c" }, () => { encoding = 0; return false; }),
  ];
  return {
    reset() { encoding = 0; },
    serialize() { return encoding ? `\x1b[?${encoding}h` : "\x1b[?1006l"; },
    dispose() { handlers.forEach(handler => handler.dispose()); },
  };
}
