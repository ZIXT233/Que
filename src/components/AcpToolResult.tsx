import { memo } from 'react';
import { FileDiff } from './chat/FileDiff';
import { MarkdownMessage, MarkdownLink } from './MarkdownMessage';
import { useI18n } from '@/hooks/useI18n';
import { Disclosure } from './chat/Disclosure';

type ToolBlock = { title?: string; status?: string; content?: unknown; rawInput?: unknown; rawOutput?: unknown };
type Data = Record<string, unknown>;
const object = (value: unknown): Data => value && typeof value === 'object' ? value as Data : {};
const text = (value: unknown) => typeof value === 'string' ? value : '';
const printable = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const webLink = (value: unknown) => typeof value === 'string' && /^https?:\/\//i.test(value);

/** The raw call and its result, for formats the readable view does not cover. */
export function ToolPayload({ block }: { block: ToolBlock }) {
  const { t } = useI18n();
  return <>
    {block.rawInput !== undefined && <><h4>{t('acp.tool.input')}</h4><pre>{printable(block.rawInput)}</pre></>}
    {block.rawOutput !== undefined && <><h4>{t('acp.tool.output')}</h4><pre>{printable(block.rawOutput)}</pre></>}
    {block.content !== undefined && <pre>{printable(block.content)}</pre>}
  </>;
}

/** A tool's result, readable, with its raw payload one fold further down. */
export function ToolResultBody({ block }: { block: ToolBlock }) {
  const { t } = useI18n();
  const content = Array.isArray(block.content) ? block.content : [];
  function render(value: unknown, index: number) {
    const item = object(value);
    if (item.type === 'diff') return <FileDiff key={index} path={text(item.path)} oldText={typeof item.oldText === 'string' ? item.oldText : undefined} newText={text(item.newText)}/>;
    if (item.type === 'terminal') return <p key={index}>{t('acp.tool.terminal')}</p>;
    const body = item.type === 'content' ? object(item.content) : item;
    if (body.type === 'text' && typeof body.text === 'string') return <MarkdownMessage key={index} content={body.text} role="assistant"/>;
    const mime = text(body.mimeType), data = text(body.data);
    if (body.type === 'image' && /^image\/(png|jpeg|gif|webp|avif)$/i.test(mime) && data) return <img key={index} className="cq-acp-result-image" alt={t('acp.tool.image')} src={`data:${mime};base64,${data}`}/>;
    if (body.type === 'audio' && /^audio\/[a-z0-9.+-]+$/i.test(mime) && data) return <audio key={index} controls preload="none" src={`data:${mime};base64,${data}`}/>;
    if (body.type === 'resource' || body.type === 'resource_link') {
      const resource = body.type === 'resource' ? object(body.resource) : body;
      const uri = text(resource.uri), label = text(body.title) || text(body.name) || uri || t('acp.tool.resource');
      return <section key={index} className="cq-acp-resource"><header>{webLink(uri) ? <MarkdownLink href={uri}>{label}</MarkdownLink> : <span>{label}</span>}</header>{typeof resource.text === 'string' && <pre>{resource.text}</pre>}</section>;
    }
    return <p key={index}>{t('acp.tool.unsupported')}</p>;
  }
  const hasRaw = block.rawInput !== undefined || block.rawOutput !== undefined || block.content !== undefined;
  return <div className="cq-acp-tool-body">{content.map(render)}
    {!content.length && typeof block.rawOutput === 'string' && <pre>{block.rawOutput}</pre>}
    {hasRaw && <Disclosure className="cq-acp-raw" summary={t('acp.tool.details')}><ToolPayload block={block}/></Disclosure>}
  </div>;
}

/** Render the ACP tool content envelope, retaining unsupported payloads for inspection. */
export const AcpToolResult = memo(function AcpToolResult({ block }: { block: ToolBlock }) {
  const { t } = useI18n();
  return <Disclosure className="cq-acp-activity cq-acp-tool"
    summary={<><span>{block.title || t('acp.tool.title')}</span><small>{['pending','in_progress','completed','failed'].includes(block.status || '') ? t(`acp.tool.${block.status}`) : block.status}</small></>}>
    <ToolResultBody block={block}/>
  </Disclosure>;
});
