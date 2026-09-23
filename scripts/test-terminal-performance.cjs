const fs = require("node:fs");
const assert = require("node:assert/strict");
const test = require("node:test");
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
};
const { TerminalPerformanceProbe } = require("../src/lib/terminal-performance.ts");

test("distinguishes received cursor from parsed cursor and measures queue delay", t => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const reports = [];
  const probe = new TerminalPerformanceProbe(() => ({ renderer: "webgl" }), s => reports.push(s));
  const first = probe.enqueue(100, 150, false, 2);
  probe.start(first);
  probe.prepared(first, 3);
  now = 10;
  const second = probe.enqueue(20, 180);
  now = 50;
  probe.complete(first);
  assert.equal(probe.snapshot().receivedOffset, 180);
  assert.equal(probe.snapshot().parsedOffset, 150);
  assert.equal(probe.snapshot().pendingChars, 20);
  now = 80;
  probe.start(second);
  probe.prepared(second, 1);
  now = 100;
  probe.complete(second);
  now = 5200;
  t.mock.timers.tick(5000);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].queueMaxMs, 70);
  assert.equal(reports[0].writeMaxMs, 50);
  assert.equal(reports[0].timerLateMs, 200);
  assert.equal(reports[0].replayChars, 100);
  assert.equal(reports[0].parsedOffset, 180);
  assert.equal(reports[0].pendingChunks, 0);
  t.mock.timers.tick(10000);
  assert.equal(reports.length, 1, "idle terminals must not keep sending logs");
  probe.dispose();
});

test("draw timing preserves receiver and exceptions, restores old renderers", t => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const probe = new TerminalPerformanceProbe(() => ({}), () => {});
  probe.enqueue(1, 1);
  const error = new Error("renderer failure");
  const renderer = { renderRows(start, end) {
    assert.equal(this, renderer);
    assert.deepEqual([start, end], [0, 36]);
    now += 7;
    throw error;
  } };
  const original = renderer.renderRows;
  const terminal = { _core: { _renderService: { _renderer: { value: renderer } } } };
  probe.watchRenderer(terminal);
  probe.watchRenderer(terminal);
  assert.throws(() => renderer.renderRows(0, 36), e => e === error);
  assert.equal(probe.snapshot().current.renderCpuMaxMs, 7);
  assert.equal(probe.snapshot().current.renderCalls, 1);
  probe.watchRenderer({});
  assert.equal(renderer.renderRows, original);
  assert.equal(probe.snapshot().rendererTiming, false);
  probe.watchRenderer(terminal);
  probe.dispose();
  assert.equal(renderer.renderRows, original);
});

test("clear observer counts split CSI once without consuming real xterm commands", async () => {
  const { Terminal } = require("@xterm/xterm");
  const terminal = new Terminal({ cols: 10, rows: 3, allowProposedApi: true });
  const probe = new TerminalPerformanceProbe(() => ({}), () => {});
  terminal.parser.registerCsiHandler({ final: "J" }, params => {
    if (typeof params[0] === "number") probe.clear(params[0]);
    return false;
  });
  const write = data => new Promise(resolve => terminal.write(data, resolve));
  try {
    await write("old\r\n".repeat(10));
    assert.ok(terminal.buffer.active.baseY > 0);
    await write("\x1b[");
    await write("2J\x1b[3");
    await write("J\x1b[Hnew");
    assert.equal(terminal.buffer.active.baseY, 0);
    assert.equal(terminal.buffer.active.getLine(0).translateToString(true), "new");
    assert.equal(probe.snapshot().current.clearScreen, 1);
    assert.equal(probe.snapshot().current.clearScrollback, 1);
  } finally {
    probe.dispose();
    terminal.dispose();
  }
});
