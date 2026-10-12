import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

async function load(entry) {
  const dir = await mkdtemp(join(tmpdir(), "queacp-tile-"));
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
  assert.deepEqual(tilePreview(undefined, "earlier reply"), { status: "idle", text: "earlier reply" });
  const done = tilePreview(snapshot({ id: "a", state: "completed", text: "q", blocks: [{ type: "text_delta", stream: "thought", text: "hidden" }, reply("the answer")] }));
  assert.deepEqual(done, { status: "waiting", activity: undefined, text: "the answer" });
  const working = tilePreview(snapshot({ id: "a", state: "running", text: "q", blocks: [reply("so far"), { type: "tool_call", title: "Read a.ts", status: "in_progress" }, { type: "tool_call", title: "done", status: "completed" }] }));
  assert.equal(working.status, "working");assert.equal(working.activity, "Read a.ts");assert.equal(working.text, "so far");
  const asking = tilePreview(snapshot({ id: "a", state: "running", text: "q", blocks: [{ type: "decision", state: "pending", request: { toolCall: { title: "Edit plan.md" } } }] }));
  assert.equal(asking.status, "decision");assert.equal(asking.activity, "Edit plan.md");assert.equal(asking.text, "q", "the request it works on, before any reply");
  const queued = tilePreview(snapshot({ id: "a", state: "completed", text: "q", blocks: [reply("kept")] }, { id: "b", state: "queued", text: "later", blocks: [] }));
  assert.equal(queued.text, "kept", "a queued message is not where it stands yet");
});

test("a long reply keeps its end, from a line start", () => {
  const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  const { text } = tilePreview(snapshot({ id: "a", state: "completed", text: "q", blocks: [reply(long)] }), "", 60);
  assert.ok(text.startsWith("…line "), text);assert.ok(text.endsWith("line 39"));assert.ok(text.length <= 61);
});
