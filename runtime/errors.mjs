export function sessionErrorMessage(error) {
  const messages = [];
  const seen = new Set();
  for (let current = error; current && !seen.has(current); current = current.cause) {
    seen.add(current);
    if (typeof current.message === 'string') messages.push(current.message);
    if (typeof current.data?.details === 'string') messages.push(current.data.details);
  }
  if (messages.some(message => message.includes('already has an active writer'))) {
    return '该会话正在另一个 Codex 实例中打开，暂时无法接管。请先关闭原来的会话，再回来重试。';
  }
  return [...new Set(messages)].join('：') || String(error);
}
