// Exercise the real session, writer and xterm parser with simulated DOM sizing
// and transport. This covers lifecycle/failure handling, not native WebView rendering.
const fs = require("node:fs");
const assert = require("node:assert/strict");
const { test } = require("node:test");
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  fileName: filename,
}).outputText, filename);
const { Terminal } = require("@xterm/xterm");
const { TerminalSession } = require("../src/lib/terminal-pool.ts");
const { createTerminalWriter, terminalRequest, TerminalRequestError } = require("../src/lib/terminal-client.ts");

class Host extends EventTarget {
  isConnected = false;
  offsetWidth = 800;
  offsetHeight = 400;
  classList = { add() {}, remove() {}, contains() { return false; } };
  closest() { return null; }
  appendChild(child) { child.isConnected = true; }
  remove() { this.isConnected = false; }
}

function setup(t) {
  const root = { dataset: {}, classList: { contains: () => false } };
  const browser = Object.assign(new EventTarget(), { setTimeout, localStorage: { getItem: () => null } });
  const globals = {
    window: browser,
    navigator: { onLine: true, platform: "Linux", userAgent: "Linux" },
    document: { documentElement: root, createElement: () => new Host() },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    ResizeObserver: class { observe() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
  };
  const streams = [];
  globals.EventSource = class {
    closed = false;
    constructor(url) { this.url = url; streams.push(this); }
    close() { this.closed = true; }
  };
  const sizes = [];
  let offset = 0;
  const output = (data, reset) => {
    const from = offset;
    offset += Buffer.byteLength(data);
    for (const stream of streams.filter(stream => !stream.closed)) {
      stream.onmessage?.({ data: JSON.stringify({ type: "output", data, from, offset, reset }) });
    }
  };
  globals.fetch = async (url, options) => {
    if (options?.method === "POST" && url.startsWith("/api/terminal/")) {
      const body = JSON.parse(options.body);
      if (body.type === "resize") {
        sizes.push([body.cols, body.rows]);
        // A resize-aware TUI paints a marker on its bottom-right cell. A stale
        // PTY size puts it in the wrong row/column of the returning xterm.
        const data = `\x1b[?1049h\x1b[2J\x1b[H${body.cols}x${body.rows}\x1b[${body.rows};${body.cols}H#`;
        output(data);
      }
    }
    return { ok: true, json: async () => ({ id: "shared-terminal" }) };
  };
  const restoreGlobals = [];
  for (const [key, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    restoreGlobals.push(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else delete globalThis[key];
    });
  }
  t.mock.method(Terminal.prototype, "open", () => {});
  const sessions = [];
  t.after(() => {
    sessions.forEach(session => session.release());
    restoreGlobals.forEach(restore => restore());
  });
  async function view(cols, rows, readOnly = false, { params = {}, callbacks = {} } = {}) {
    const session = new TerminalSession({ id: "shared-terminal", cwd: "/", restored: true, ...params });
    sessions.push(session);
    // Only geometry and GPU rendering are stubbed; resize events, buffers,
    // SSE lifecycle, fitting schedule and HTTP writer run production code.
    session.loadGpu = () => {};
    session.fit.fit = () => session.terminal.resize(cols, rows);
    const sink = { current: { onUpdate() {}, ...callbacks } };
    session.attach(new Host(), sink, { active: true, focusReporting: false, readOnly });
    await session.started;
    await Promise.resolve();
    return { session, sink, open: () => session.events.onopen() };
  }
  return { view, sizes, sessions, output };
}

async function settle() {
  // Fit uses a task, the writer uses promises, and xterm parses asynchronously.
  await new Promise(resolve => setTimeout(resolve, 30));
}

async function waitFor(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert(predicate(), "condition did not become true");
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const response = (status, data = {}) => ({ ok: status < 400, status, json: async () => data });

test("returning from a detached window restores PTY size even when main xterm size is unchanged", async t => {
  const { view, sizes } = setup(t);
  const main = await view(80, 24);
  main.open();
  await settle();
  assert.deepEqual(sizes, [[80, 24]]);
  const originalTerminal = main.session.terminal;

  for (const detachedSize of [[132, 44], [100, 32]]) {
    main.session.setViewOptions(main.sink, { active: false });
    await Promise.resolve();
    const detached = await view(...detachedSize);
    detached.open();
    await settle();
    assert.deepEqual(sizes.at(-1), detachedSize);
    detached.session.release();

    main.session.setViewOptions(main.sink, { active: true });
    await Promise.resolve();
    main.open();
    await settle();
    assert.deepEqual(sizes.at(-1), [80, 24], "return must reclaim the shared PTY dimensions");
    assert.equal(main.session.terminal, originalTerminal, "return must reuse the existing xterm");
    const buffer = originalTerminal.buffer.active;
    assert.equal(buffer.getLine(0).translateToString(true), "80x24");
    assert.equal(buffer.getLine(23).getCell(79).getChars(), "#");

    const count = sizes.length;
    main.session.refreshPlacement();
    main.session.refreshPlacement();
    await settle();
    assert.equal(sizes.length, count, "ordinary fits still deduplicate unchanged dimensions");
  }
  assert.deepEqual(sizes, [[80, 24], [132, 44], [80, 24], [100, 32], [80, 24]]);
});

test("reconnect retains the size refresh until a hidden host can be measured", async t => {
  const { view, sizes } = setup(t);
  const main = await view(80, 24);
  main.open();
  await settle();
  const oldStream = main.session.events;
  main.session.pageHide();
  main.session.host.offsetWidth = 0;
  main.session.connect();
  main.open();
  await settle();
  assert.deepEqual(sizes, [[80, 24]], "a hidden host must not send placeholder dimensions");
  main.session.host.offsetWidth = 800;
  main.session.refreshPlacement();
  await settle();
  assert.deepEqual(sizes, [[80, 24], [80, 24]]);
  oldStream.onopen();
  main.session.refreshPlacement();
  await settle();
  assert.equal(sizes.length, 2, "obsolete SSE callbacks must not invalidate the current size");
});

test("read-only terminals do not resize the shared PTY on connect or placement", async t => {
  const { view, sizes } = setup(t);
  const readOnly = await view(80, 24, true);
  readOnly.open();
  readOnly.session.refreshPlacement();
  await settle();
  assert.deepEqual(sizes, []);
});

test("restore 503 preserves local/SSH sessions and retries only the existence check", async t => {
  for (const sshHost of [undefined, "test-host"]) await t.test(sshHost ?? "local", async t => {
    const { view } = setup(t);
    const requests = [];
    let reads = 0, unavailable = 0;
    global.fetch = async (url, options) => {
      if (url === "/api/logs") return response(200);
      requests.push([options?.method ?? "GET", url]);
      if (!options?.method && ++reads === 1) return response(503, { error: "temporarily unavailable" });
      return response(200, { id: "shared-terminal" });
    };
    const { session, open } = await view(80, 24, false, {
      params: { sshHost }, callbacks: { onUnavailable: () => unavailable++ },
    });
    assert.equal(session.state.status, "error");
    assert.equal(unavailable, 0);
    await waitFor(() => session.events !== null);
    open();
    assert.equal(session.state.status, "ready");
    assert.equal(session.state.error, null);
    assert.equal(unavailable, 0);
    assert.deepEqual(requests, [["GET", "/api/terminal/shared-terminal"], ["GET", "/api/terminal/shared-terminal"]]);
  });
});

test("network, timeout and abort failures recover on online without concurrent initialization", async t => {
  for (const error of [new TypeError("Failed to fetch"), new DOMException("The operation was aborted due to timeout", "TimeoutError"), new DOMException("Aborted", "AbortError")]) {
    await t.test(error.name, async t => {
      const { view } = setup(t);
      const retry = deferred();
      let reads = 0, unavailable = 0;
      global.fetch = async (url, options) => {
        if (!options?.method && url.startsWith("/api/terminal/")) {
          if (++reads === 1) throw error;
          return retry.promise;
        }
        return response(200);
      };
      const { session } = await view(80, 24, false, { callbacks: { onUnavailable: () => unavailable++ } });
      assert.equal(session.state.status, "error");
      assert(session.state.error);
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new Event("online"));
      assert.equal(reads, 2);
      retry.resolve(response(200));
      await session.started;
      assert(session.events);
      assert.equal(session.state.error, null);
      assert.equal(unavailable, 0);
    });
  }
});

test("paused restore stops retrying until selected; destroyed restore cannot launch SSH fallback", async t => {
  const { view, sessions } = setup(t);
  let reads = 0;
  global.fetch = async (url, options) => !options?.method && url.startsWith("/api/terminal/")
    ? (++reads === 1 ? response(503) : response(200)) : response(200);
  const { session, sink } = await view(80, 24);
  session.setViewOptions(sink, { active: false });
  await Promise.resolve();
  window.dispatchEvent(new Event("online"));
  await new Promise(resolve => setTimeout(resolve, 550));
  assert.equal(reads, 1);
  session.setViewOptions(sink, { active: true });
  await waitFor(() => session.startReady);
  assert.equal(reads, 2);

  const mutations = [];
  const missing = deferred();
  global.fetch = async (url, options) => !options?.method ? missing.promise : (mutations.push(url), response(200));
  let unavailable = 0;
  const destroyed = view(80, 24, false, { params: { sshHost: "test-host" }, callbacks: { onUnavailable: () => unavailable++ } });
  // Dispose while the lookup is still pending, before its 404 arrives.
  sessions.at(-1).release();
  missing.resolve(response(404));
  await destroyed;
  assert.equal(unavailable, 0);
  assert.deepEqual(mutations.filter(url => url !== "/api/logs"), []);
});

test("only a confirmed missing terminal notifies unavailable or creates an SSH replacement", async t => {
  for (const status of [403, 404]) await t.test(String(status), async t => {
    const { view } = setup(t);
    let unavailable = 0;
    global.fetch = async (url, options) => !options?.method ? response(status, { error: "lookup failed" }) : response(200);
    const { session } = await view(80, 24, false, { callbacks: { onUnavailable: () => unavailable++ } });
    assert.equal(unavailable, status === 404 ? 1 : 0);
    assert.equal(session.state.status, "error");
    assert.equal(session.retryStart, false);
  });
  await t.test("SSH missing then failed create is preserved", async t => {
    const { view } = setup(t);
    let creates = 0, unavailable = 0;
    global.fetch = async (url, options) => {
      if (!options?.method) return response(404);
      if (url === "/api/terminal") { creates++; return response(503); }
      return response(200);
    };
    const { session } = await view(80, 24, false, { params: { sshHost: "test-host" }, callbacks: { onUnavailable: () => unavailable++ } });
    window.dispatchEvent(new Event("online"));
    assert.equal(creates, 1);
    assert.equal(unavailable, 0);
    assert.equal(session.state.status, "error");
    assert.equal(session.retryStart, false);
  });
  await t.test("confirmed missing SSH session still reconnects normally", async t => {
    const { view } = setup(t);
    const creates = [];
    global.fetch = async (url, options) => {
      if (!options?.method) return response(404);
      if (url === "/api/terminal") creates.push(JSON.parse(options.body));
      return response(200);
    };
    const { session, open } = await view(80, 24, false, { params: { sshHost: "test-host" } });
    assert.equal(creates.length, 1);
    assert.equal(creates[0].id, "shared-terminal");
    assert.equal(creates[0].sshHost, "test-host");
    open();
    assert.equal(session.state.status, "ready");
  });
});

test("ambiguous create timeout is visible and never automatically launches a second process", async t => {
  const { view } = setup(t);
  let creates = 0;
  global.fetch = async url => {
    if (url === "/api/terminal") { creates++; throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); }
    return response(200);
  };
  const { session } = await view(80, 24, false, { params: { restored: false } });
  assert.equal(session.state.status, "error");
  assert.equal(session.startFailed, true);
  window.dispatchEvent(new Event("online"));
  assert.equal(creates, 1);
  assert.equal(session.retryStart, false);
});

test("failed input discards queued input, resize, binary and upload requests", async t => {
  setup(t);
  const first = deferred();
  const sent = [], errors = [];
  global.fetch = async (_url, options) => {
    sent.push(options.body);
    if (sent.length === 1) return first.promise;
    return response(200);
  };
  const writer = createTerminalWriter("shared-terminal", error => errors.push(error));
  writer.write("first-command");
  await Promise.resolve();
  writer.resize(100, 40);
  writer.writeBinary("\x1b[M");
  writer.pasteImages([{ arrayBuffer: () => { throw new Error("must not read a queued image"); } }], false);
  writer.pasteFiles([], false);
  writer.write("later-command\n");
  first.reject(new TypeError("connection interrupted"));
  await writer.stop();
  assert.equal(errors.length, 1);
  assert.deepEqual(sent.map(body => JSON.parse(body)), [{ type: "input", data: "first-command", human: false }]);
});

test("protocol failure while preparing an image cancels the image and following input", async t => {
  setup(t);
  const image = deferred();
  const sent = [], errors = [];
  global.fetch = async (_url, options) => {
    sent.push(JSON.parse(options.body));
    throw new TypeError("reply failed");
  };
  const writer = createTerminalWriter("shared-terminal", error => errors.push(error));
  writer.pasteImages([{ type: "image/png", arrayBuffer: () => image.promise }], false);
  await Promise.resolve();
  writer.write("tail\n");
  writer.reply("\x1b[0n");
  await waitFor(() => errors.length === 1);
  image.resolve(new ArrayBuffer(0));
  await writer.stop();
  assert.deepEqual(sent, [{ type: "input", data: "\x1b[0n" }]);
});

test("clean writer stop still drains accepted input in order", async t => {
  setup(t);
  const sent = [];
  global.fetch = async (_url, options) => { sent.push(JSON.parse(options.body)); return response(200); };
  const writer = createTerminalWriter("shared-terminal", error => { throw error; });
  writer.write("before");
  writer.resize(80, 24);
  writer.write("after");
  await writer.stop();
  writer.write("ignored");
  assert.deepEqual(sent.map(body => body.type), ["input", "resize", "input"]);
  assert.equal(sent[2].data, "after");
});

test("focus reports respect read-only, exit and connection state while preserving live focus transitions", async t => {
  const { view, output } = setup(t);
  const normalFetch = global.fetch;
  const inputs = [];
  global.fetch = async (url, options) => {
    const body = options?.body && JSON.parse(options.body);
    if (body?.type === "input") inputs.push(body.data);
    return normalFetch(url, options);
  };
  const { session, sink, open } = await view(80, 24, true);
  session.setViewOptions(sink, { focusReporting: true });
  await Promise.resolve();
  open();
  const data = "\x1b[?1004h";
  output(data, true);
  await settle();
  assert.deepEqual(inputs, [], "read-only replay must not write focus sequences");
  session.setViewOptions(sink, { readOnly: false });
  await settle();
  assert.deepEqual(inputs, ["\x1b[I"]);
  session.setViewOptions(sink, { active: false });
  await settle();
  assert.deepEqual(inputs, ["\x1b[I", "\x1b[O"]);
  session.setViewOptions(sink, { active: true });
  await Promise.resolve();
  await settle();
  assert.equal(inputs.length, 2, "a pending SSE must not write focus input");
  open();
  await settle();
  assert.deepEqual(inputs, ["\x1b[I", "\x1b[O", "\x1b[I"]);
  session.events.onmessage({ data: JSON.stringify({ type: "exit", exitCode: 0 }) });
  session.setViewOptions(sink, { active: false });
  await settle();
  assert.equal(inputs.length, 3, "an exited terminal must not write blur input");
});

test("HTTP error status survives an invalid JSON response for safe retry classification", async t => {
  setup(t);
  global.fetch = async () => ({ status: 503, ok: false, json: async () => { throw new SyntaxError("bad gateway HTML"); } });
  await assert.rejects(terminalRequest("/api/terminal/shared-terminal"), error => error instanceof TerminalRequestError && error.status === 503);
});

test("a response body timeout remains retryable after successful HTTP headers", async t => {
  const { view } = setup(t);
  let reads = 0, unavailable = 0;
  global.fetch = async (url, options) => {
    if (!options?.method && ++reads === 1) return { status: 200, ok: true, json: async () => { throw new DOMException("Timed out", "TimeoutError"); } };
    return response(200);
  };
  const { session } = await view(80, 24, false, { callbacks: { onUnavailable: () => unavailable++ } });
  assert.equal(session.state.status, "error");
  assert.equal(session.retryStart, true);
  window.dispatchEvent(new Event("online"));
  await session.started;
  assert(session.events);
  assert.equal(unavailable, 0);
});

test("server-marked read-only transcripts and queued output after exit cannot send focus input", async t => {
  for (const readOnly of [true, false]) await t.test(readOnly ? "transcript" : "exit before parse", async t => {
    const { view, output } = setup(t);
    const inputs = [];
    global.fetch = async (_url, options) => {
      if (!options?.method) return response(200, { readOnly });
      const body = JSON.parse(options.body);
      if (body.type === "input") inputs.push(body.data);
      return response(200);
    };
    const { session, sink, open } = await view(80, 24);
    session.setViewOptions(sink, { focusReporting: true });
    await Promise.resolve();
    open();
    output("\x1b[?1004h", true);
    if (!readOnly) session.events.onmessage({ data: JSON.stringify({ type: "exit", exitCode: 0 }) });
    await settle();
    assert.deepEqual(inputs, []);
  });
});

test("returning a parked terminal to the active card restores keyboard focus", async t => {
  const { view } = setup(t);
  let focused = 0;
  t.mock.method(Terminal.prototype, "focus", () => { focused++; });
  const { session, sink } = await view(80, 24);
  session.setViewOptions(sink, { active: false });
  await Promise.resolve();
  focused = 0;
  session.setViewOptions(sink, { active: true });
  await Promise.resolve();
  assert.equal(focused, 1);
});
