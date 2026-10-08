import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

async function load(entry) {
  const dir = await mkdtemp(join(tmpdir(), "que-recap-"));
  try {
    const out = join(dir, "module.mjs");
    const result = await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", write: false });
    await writeFile(out, result.outputFiles[0].text);
    return await import(pathToFileURL(out).href);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

const turn = (id, text, extra = {}) => ({ id, text, state: "completed", blocks: [], ...extra });
const reply = text => [{ type: "text_delta", stream: "thought", text: "hidden" }, { type: "text_delta", stream: "message", text }];

test("recap says what the user last asked and what happened since", async () => {
  const { cardRecap, timeAgo } = await load("src/lib/card-recap.ts");
  assert.equal(cardRecap([turn("a", "build foo"), turn("b", "again")]), null, "short transcripts need no recap");
  const recap = cardRecap([
    turn("1", "package foo 2.3 for the distro", { at: 1 }),
    turn("2", "fix the failing patch", { at: 2, blocks: reply("patched") }),
    turn("3", "please pull and restart", { sender: { cardId: "be", name: "Backend" }, blocks: reply("restarted") }),
    turn("4", "status data", { source: "event", blocks: reply("noted") }),
    turn("5", "queued later", { state: "queued" }),
  ]);
  assert.equal(recap.goal, "package foo 2.3 for the distro");
  assert.equal(recap.lastAsk, "fix the failing patch");
  assert.equal(recap.lastAskAt, 2);
  assert.deepEqual(recap.since, [{ name: "Backend", count: 1 }, { name: "Que", count: 1 }]);
  assert.equal(recap.lastReply, "noted", "thoughts are never shown");
  assert.deepEqual(recap.peers, ["Backend"]);
  assert.equal(timeAgo(Date.now() - 3 * 3600 * 1000), "3 小时前");
});

test("digest cron validation matches the backend presets", async () => {
  const { cronValid, digestFromStorage, DEFAULT_BUTLER_DIGEST } = await load("src/lib/butler-digest.ts");
  for (const ok of ["0 9 * * 1-5", "*/15 * * * *", "0 9,14 1 1-6 0,7"]) assert.ok(cronValid(ok), ok);
  for (const bad of ["", "* * * *", "60 * * * *", "0 24 * * *", "*/0 * * * *", "0 9 * * 8", "a b c d e"]) assert.ok(!cronValid(bad), bad);
  assert.deepEqual(digestFromStorage("{broken"), DEFAULT_BUTLER_DIGEST);
  assert.equal(digestFromStorage(JSON.stringify({ ...DEFAULT_BUTLER_DIGEST, mode: "daily" })).mode, "daily");
});
