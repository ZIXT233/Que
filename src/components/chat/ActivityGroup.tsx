import { memo } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { AcpToolResult } from '../AcpToolResult';
import { MarkdownMessage } from '../MarkdownMessage';
import { Disclosure } from './Disclosure';

type Activity = { type: string; stream?: string; text?: string; toolCallId?: string; title?: string; status?: string; content?: unknown; rawInput?: unknown; rawOutput?: unknown };
export function groupActivityBlocks<T extends Activity>(blocks: T[]) {
  const groups: { index: number; block?: T; activities?: T[] }[] = [];
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'tool_call' || (block.type === 'text_delta' && block.stream === 'thought')) {
      const previous = groups.at(-1);
      if (previous?.activities) previous.activities.push(block);
      else groups.push({ index, activities: [block] });
    } else groups.push({ index, block });
  }
  return groups;
}
/** The steps of a group, one after another: a tool's call and result, or a thought. */
export function ActivityItems({ blocks }: { blocks: Activity[] }) {
  return <>{blocks.map((block, index) => block.type === 'tool_call'
    ? <AcpToolResult key={block.toolCallId || index} block={block}/>
    : <MarkdownMessage key={index} content={block.text || ''} role="assistant"/>)}</>;
}
// Grouping rebuilds the array every render; compare its items, which keep their
// identity while a poll leaves them unchanged.
export const ActivityGroup = memo(function ActivityGroup({ blocks, running }: { blocks: Activity[]; running: boolean }) {
  const { t } = useI18n();
  const tools = blocks.filter(block => block.type === 'tool_call');
  const active = running ? [...tools].reverse().find(block => ['pending','in_progress'].includes(block.status || '')) : undefined;
  const failed = tools.filter(block => block.status === 'failed').length;
  const completed = tools.filter(block => block.status === 'completed').length;
  const label = active ? (active.title || t('acp.tool.title')) : tools.length
    ? `${tools.length} ${t('acp.activity.tools')}` : t('acp.activity.thinking');
  const status = active ? t('acp.tool.in_progress') : failed ? `${failed} ${t('acp.tool.failed')}`
    : tools.length && completed === tools.length ? t('acp.tool.completed') : '';
  return <Disclosure className="cq-acp-activity fc-activity-group"
    summary={<><span className="fc-activity-label" title={label}>{label}</span>{status && <small data-failed={failed > 0}>{status}</small>}</>}>
    <div className="fc-activity-items"><ActivityItems blocks={blocks}/></div>
  </Disclosure>;
}, (a, b) => a.running === b.running && a.blocks.length === b.blocks.length && a.blocks.every((block, index) => block === b.blocks[index]));
