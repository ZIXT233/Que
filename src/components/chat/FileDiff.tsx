import { memo, useMemo } from 'react';
import { diffLines } from 'diff';

export const FileDiff = memo(function FileDiff({ path, oldText, newText }: { path: string; oldText?: string; newText: string }) {
  const rows = useMemo(() => {
    const parts = diffLines(oldText ?? '', newText, { timeout: 100 }) ?? [
      { value: oldText ?? '', removed: true, added: false }, { value: newText, added: true, removed: false },
    ];
    let before = 0, after = 0;
    return parts.flatMap(part => {
      const lines = part.value.split('\n');
      if (lines.at(-1) === '') lines.pop();
      return lines.map(value => ({ value, kind: part.added ? 'add' : part.removed ? 'remove' : 'same',
        before: part.added ? '' : String(++before), after: part.removed ? '' : String(++after) }));
    });
  }, [oldText, newText]);
  return <section className="fc-file-diff"><header><span>{path}</span><small><ins>+{rows.filter(r => r.kind === 'add').length}</ins> <del>−{rows.filter(r => r.kind === 'remove').length}</del></small></header>
    <div className="fc-diff-scroll" tabIndex={0}><table aria-label={path}><tbody>{rows.map((row, i) => <tr key={i} data-kind={row.kind}><td aria-hidden="true">{row.before}</td><td aria-hidden="true">{row.after}</td><td aria-hidden="true">{row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : ' '}</td><td><code>{row.value || ' '}</code></td></tr>)}</tbody></table></div>
  </section>;
});
