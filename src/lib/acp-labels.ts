// Translate display labels only. ACP IDs and values always go back unchanged.
type Translate = (key: string) => string;
type Option = { id?: string; category?: string; name: string };
const categories: Record<string, string> = {
  model: 'model', thought_level: 'thinking', mode: 'mode',
};
const thoughts: Record<string, string> = {
  none: 'none', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high',
  xhigh: 'xhigh', 'extra high': 'xhigh', 'extra-high': 'xhigh', max: 'max', ultra: 'ultra',
};
export function acpOptionLabel(option: Option, t: Translate): string {
  const normalized=(option.id || option.name).toLowerCase().replace(/[ _-]/g,'');
  if(['fast','fastmode','servicetier'].includes(normalized)) return t('acp.controls.fast');
  if(['collaboration','collaborationmode'].includes(normalized)) return t('acp.controls.collaboration');
  const key = categories[option.category || ''];
  return key ? t(`acp.controls.${key}`) : option.name;
}
export function acpChoiceLabel(option: Option, name: string, t: Translate): string {
  // Model names and unknown provider-specific values must retain their identity.
  const label = name.trim().toLowerCase();
  const normalized=[option.id,option.name].map(v=>(v||'').toLowerCase().replace(/[ _-]/g,''));
  if(normalized.some(k=>['fast','fastmode','servicetier','collaboration','collaborationmode'].includes(k))) {
    const common:Record<string,string>={on:'on',off:'off',default:'default',plan:'plan'};
    if(common[label])return t(`acp.values.${common[label]}`);
  }
  const key = option.category === 'thought_level' ? thoughts[label]
    : undefined;
  return key ? t(`acp.values.${key}`) : name;
}
export function acpStartupLabel(stage: string, t: Translate): string {
  const aliases: Record<string,string> = {
    preparing: 'preparing', '正在准备 Agent 环境': 'preparing',
    spawning: 'spawning', '正在启动 Agent': 'spawning',
    connecting: 'connecting', '正在连接并恢复会话': 'connecting',
    failed: 'failed', '启动失败': 'failed',
  };
  return t(`acp.start.${aliases[stage] || 'preparing'}`);
}
