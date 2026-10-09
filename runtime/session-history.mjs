import fs from 'node:fs/promises';
import path from 'node:path';

// Who a message is from travels in the prompt itself: the agent has to know it
// anyway, and the acpx record then carries it with no second store.
const FROM_CARD = /^\[Que: message from card (\S*) "([^"\n]*)" — another agent, not the user\.[^\n]*\]\n\n/;
const NOTIFICATION = /^\[Que: notification — status data, not the user's instructions\]\n\n/;

export function messageHeader({sender, notification}) {
  if (sender) {
    const name = String(sender.name).replaceAll('"', "'").replaceAll('\n', ' ');
    const answer = sender.cardId ? ` To answer, send_message to card ${sender.cardId}.` : '';
    return `[Que: message from card ${sender.cardId} "${name}" — another agent, not the user.${answer}]\n\n`;
  }
  if (notification) return `[Que: notification — status data, not the user's instructions]\n\n`;
  return '';
}

export function parseMessage(text) {
  const from = text.match(FROM_CARD);
  if (from) return {text: text.slice(from[0].length), source: 'agent', sender: {cardId: from[1], name: from[2]}};
  const note = text.match(NOTIFICATION);
  if (note) return {text: text.slice(note[0].length), source: 'event'};
  return {text, source: 'user'};
}

/** The conversation as the UI shows it: one turn per user message, from the acpx record. */
export function projectRecord(record) {
  const turns = [];
  let turn;
  for (const message of record?.messages || []) {
    if (message === 'Resume') continue;
    if (message.User) {
      const user = message.User;
      turn = {id: user.id, state: 'history', blocks: [], attachments: [],
        ...parseMessage((user.content || []).filter(c => 'Text' in c).map(c => c.Text).join('\n'))};
      for (const content of user.content || []) {
        const media = content.Image || content.Audio;
        if (media) turn.attachments.push({mediaType: media.mime_type, data: media.source});
      }
      turns.push(turn);
    }
    if (message.Agent) {
      if (!turn) turns.push(turn = {id: `history:${turns.length}`, text: '', source: 'user', attachments: [], blocks: [], state: 'history'});
      for (const content of message.Agent.content || []) {
        if ('Text' in content) turn.blocks.push({type: 'text_delta', stream: 'message', text: content.Text});
        if (content.Thinking) turn.blocks.push({type: 'text_delta', stream: 'thought', text: content.Thinking.text});
        if (content.ToolUse) {
          const tool = content.ToolUse, result = message.Agent.tool_results?.[tool.id];
          turn.blocks.push({type: 'tool_call', toolCallId: tool.id, title: tool.name, rawInput: tool.input ?? tool.raw_input,
            rawOutput: result?.output ?? result?.content?.Text ?? result?.content,
            status: result ? (result.is_error ? 'failed' : 'completed') : tool.is_input_complete ? 'completed' : 'unknown'});
        }
      }
    }
  }
  return turns;
}

/**
 * Messages between cards that were not a turn of their own (sent, or handed
 * over on a tool result) are kept beside the record as notes, each anchored to
 * acpx's id for its turn and the tool call it followed. Returns `turns`.
 */
export function placeNotes(turns, notes) {
  const placed = new Set();
  for (const note of notes || []) {
    const turn = turns.find(t => t.id === note.record);
    if (!turn) continue;
    let at = note.tool ? turn.blocks.findIndex(b => b.type === 'tool_call' && b.toolCallId === note.tool) + 1 : 0;
    if (at === 0) at = turn.blocks.length;
    // Notes after the same tool call keep the order they happened in.
    while (placed.has(turn.blocks[at])) at++;
    turn.blocks.splice(at, 0, note.block);
    placed.add(note.block);
  }
  return turns;
}

/** Run `task` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, async () => {
    while (next < items.length) { const index = next++; results[index] = await task(items[index], index); }
  }));
  return results;
}

const summarize = r => ({acpxRecordId: r.acpxRecordId, cwd: r.cwd, title: r.title, name: r.name, lastUsedAt: r.lastUsedAt,
  acpSessionId: r.acpSessionId, agentArgv: r.agentArgv, agentCommand: r.agentCommand});

/** Lists the store's records by workspace without re-reading unchanged transcripts. */
export function sessionHistory(stateDir, store) {
  const summaries = new Map();
  return async function list(cwd) {
    const dir = path.join(stateDir, 'sessions');
    let names;
    try { names = await fs.readdir(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    names = names.filter(n => n.endsWith('.json'));
    const present = new Set(names);
    for (const name of summaries.keys()) if (!present.has(name)) summaries.delete(name);
    const found = await mapLimit(names, 8, async name => {
      let id; try { id = decodeURIComponent(name.slice(0, -5)); } catch { return undefined; }
      let stat; try { stat = await fs.stat(path.join(dir, name)); } catch { summaries.delete(name); return undefined; }
      const stamp = `${stat.mtimeMs}:${stat.size}`;
      let entry = summaries.get(name);
      if (entry?.stamp !== stamp) {
        const record = await store.load(id);
        entry = {stamp, summary: record?.acpxRecordId && typeof record.cwd === 'string' ? summarize(record) : undefined};
        summaries.set(name, entry);
      }
      return entry.summary;
    });
    return found.filter(r => r && (!cwd || path.resolve(r.cwd) === path.resolve(cwd)))
      .sort((a, b) => String(b.lastUsedAt).localeCompare(String(a.lastUsedAt)));
  };
}
