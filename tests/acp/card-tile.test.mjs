import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

async function load(entry) {
  const dir = await mkdtemp(join(tmpdir(), "que-tile-"));
  try {
    const out = join(dir, "module.mjs");
    const result = await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", write: false });
    await writeFile(out, result.outputFiles[0].text);
    return await import(pathToFileURL(out).href);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
const { tilePreview } = await load("src/lib/card-tile.ts");
const reply = text => ({ type: "text_delta", stream: "message", text });
const snapshot = (...turns) => ({ turns });

test("a tile shows where the conversation stands", () => {
  assert.deepEqual(tilePreview(undefined, "earlier reply"), { status: "idle", items: [{ kind: "text", text: "earlier reply" }] });
  const done = tilePreview(snapshot({ id: "a", state: "completed", text: "q", blocks: [{ type: "text_delta", stream: "thought", text: "hidden" }, reply("the "), reply("answer")] }));
  assert.deepEqual(done, { status: "waiting", ask: { text: "q", sender: undefined }, items: [{ kind: "text", text: "the answer" }] });
  const working = tilePreview(snapshot({ id: "a", state: "running", text: "q", blocks: [reply("so far"), { type: "tool_call", title: "Read a.ts", status: "in_progress" }, { type: "tool_call", title: "done", status: "completed" }] }));
  assert.equal(working.status, "working");
  assert.deepEqual(working.items, [{ kind: "text", text: "so far" }]);
  assert.deepEqual(working.live, { kind: "tool", text: "Read a.ts" }, "the running tool is the live line");
  const thinking = tilePreview(snapshot({ id: "a", state: "running", text: "q", blocks: [reply("so far"), { type: "text_delta", stream: "thought", text: "Look at the tests.\nThen fix the parser" }] }));
  assert.deepEqual(thinking.live, { kind: "thought", text: "Then fix the parser" }, "the end of its thinking");
  assert.deepEqual(thinking.items, [{ kind: "text", text: "so far" }], "thoughts stay out of the summary");
  assert.equal(done.live, undefined, "a finished turn has no live line");
  const asking = tilePreview(snapshot({ id: "a", state: "running", text: "q", blocks: [{ type: "decision", state: "pending", request: { toolCall: { title: "Edit plan.md" } } }] }));
  assert.equal(asking.status, "decision");assert.deepEqual(asking.live, { kind: "decision", text: "Edit plan.md" });assert.equal(asking.ask.text, "q");
  const peer = tilePreview(snapshot({ id: "a", state: "completed", text: "pull and restart", source: "agent", sender: { cardId: "b", name: "Backend" }, blocks: [reply("done")] }));
  assert.equal(peer.ask.sender.name, "Backend");
  assert.equal(tilePreview(snapshot({ id: "a", state: "completed", text: "digest", source: "event", blocks: [reply("ok")] })).ask, undefined, "Que's own requests are not shown as asks");
  const queued = tilePreview(snapshot({ id: "a", state: "completed", text: "q", blocks: [reply("kept")] }, { id: "b", state: "queued", text: "later", blocks: [] }));
  assert.deepEqual(queued.items, [{ kind: "text", text: "kept" }], "a queued message is not where it stands yet");
});

test("messages a card sends and is handed inside its turn show on its tile, in order", () => {
  const yang = { cardId: "y", name: "杨金水" };
  const talk = tilePreview(snapshot({ id: "a", state: "running", text: "talk to 杨金水", blocks: [
    reply("I will ask."), { type: "message", direction: "out", to: [yang], text: "ready?" },
    { type: "tool_call", title: "wait_messages", status: "completed" },
    { type: "message", direction: "in", from: yang, text: "yes" }, reply("He is ready.")] }));
  assert.deepEqual(talk.items.map(item => [item.kind, item.direction, item.text]), [
    ["message", "out", "ready?"], ["message", "in", "yes"], ["text", undefined, "He is ready."]], "the last three things, oldest first");
  assert.deepEqual(talk.items[1].peers, [yang]);
});

test("a long reply keeps its end, from a line start", () => {
  const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  const { items } = tilePreview(snapshot({ id: "a", state: "completed", text: "q", blocks: [reply(long)] }), "", 60);
  const text = items[0].text;
  assert.ok(text.startsWith("…line "), text);assert.ok(text.endsWith("line 39"));assert.ok(text.length <= 61);
});
