import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { useI18n } from "@/hooks/useI18n";
import { acpChoiceLabel, acpOptionLabel } from "@/lib/acp-labels";
import {
  choices,
  controls,
  fastPair,
  contextRatio,
  cacheHitRatio,
  finite,
  type Config,
  type Models,
  type Attachment,
  type Usage,
  type ContextUsage,
} from "./model";
import { SpeechInput, type SpeechInputHandle, type Phase } from "./SpeechInput";
import { appendTranscript } from "@/lib/speech";
import { permissionStyle } from "./permission-style";
import { ChatIcon } from "./Icons";
import { ComposerPanel } from "./ComposerPanel";
import { DiscreteSlider } from "./DiscreteSlider";
import "./composer.css";

type Props = {
  active: boolean;
  draft: string;
  history?: string[];
  quote?: string;
  onRemoveQuote?: () => void;
  onDraft: (value: string) => void;
  attachments: Attachment[];
  onFiles: (files: File[]) => void;
  onRemove: (index: number) => void;
  capabilities?: { image?: boolean; audio?: boolean };
  commands: { name: string; description?: string }[];
  options: Config[];
  models?: Models;
  context?: ContextUsage;
  usage?: Usage;
  busy: boolean;
  sending: boolean;
  running: boolean;
  disconnected: boolean;
  onSend: (text?: string) => void;
  hostAccess?: boolean;
  onHostAccess?: (enabled: boolean) => void;
  onCompact?: () => void;
  onStop: () => void;
  stopping: boolean;
  onConfig: (option: Config, value: string) => void;
};
type Panel = {
  kind: "model" | "usage" | "extra" | "config" | "add";
  anchor: HTMLElement;
  option?: Config;
};
export function Composer(props: Props) {
  const { t } = useI18n();
  const id = useId(),
    editor = useRef<HTMLTextAreaElement>(null),
    file = useRef<HTMLInputElement>(null);
  const historyBrowse = useRef<{ items: string[]; index: number; text: string } | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [speechPhase, setSpeechPhase] = useState<Phase>("idle");
  const speechBusy = speechPhase !== "idle";
  const speech = useRef<SpeechInputHandle>(null);
  const showStop = props.running && !props.draft.trim() && !props.attachments.length && !speechBusy;
  const [modelList, setModelList] = useState(false);
  const [commandIndex, setCommandIndex] = useState(0);
  const [dismissedCommand, setDismissedCommand] = useState<string | null>(null);
  const config = controls(props.options, props.models);
  const planChoices = config.planning ? choices(config.planning) : [];
  const planChoice = planChoices.find(choice => choice.value.toLowerCase() === "plan");
  const defaultChoice = planChoices.find(choice => choice.value.toLowerCase() === "default");
  const planEnabled = !!planChoice && config.planning?.currentValue === planChoice.value;
  const locked = props.busy || props.running || props.disconnected;
  const modelLocked = props.busy || props.disconnected;
  const choose = (option: Config, value: string) => {
    const settingLocked = [config.model?.id, config.effort?.id, config.fast?.id].includes(option.id) ? modelLocked : locked;
    if (!settingLocked && option.currentValue !== value) props.onConfig(option, value);
  };
  const name = (option: Config) =>
    acpChoiceLabel(
      option,
      choices(option).find((c) => c.value === option.currentValue)?.name ||
        option.currentValue,
      t,
    );
  const close = (focus = false) => {
    if (focus) panel?.anchor.focus();
    setPanel(null);
  };
  const open = (
    event: MouseEvent<HTMLButtonElement>,
    kind: Panel["kind"],
    option?: Config,
  ) => {
    const anchor = event.currentTarget;
    setPanel((current) =>
      current?.anchor === anchor ? null : { kind, anchor, option },
    );
    setModelList(false);
  };
  useEffect(() => {
    if (!props.active) setPanel(null);
  }, [props.active]);
  useLayoutEffect(() => {
    const textarea = editor.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(176, Math.max(68, textarea.scrollHeight))}px`;
  }, [props.draft]);
  const commands =
    props.draft.startsWith("/") &&
    !props.draft.includes(" ") &&
    dismissedCommand !== props.draft
      ? props.commands.filter((command) =>
          command.name.startsWith(props.draft.slice(1)),
        )
      : [];
  useEffect(() => setCommandIndex(0), [props.draft]);
  const commandAt = Math.min(commandIndex, Math.max(0, commands.length - 1));
  const pickCommand = (name: string) => {
    props.onDraft(`/${name} `);
    editor.current?.focus();
  };
  const ratio = contextRatio(props.context);
  const contextTitle =
    t("acp.usage.context") +
    " · " +
    (ratio === undefined
      ? t("acp.usage.unknown")
      : `${Math.round(ratio * 100)}%`);
  const triggerProps = (kind: Panel["kind"]) => ({
    "aria-haspopup": "dialog" as const,
    "aria-expanded": panel?.kind === kind,
  });
  const currentOption = panel?.option
    ? props.options.find((option) => option.id === panel.option!.id)
    : undefined;
  return (
    <div
      className="fc-composer"
      data-updating={props.busy || undefined}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        props.onFiles(Array.from(event.dataTransfer.files));
      }}
    >
      {!!props.attachments.length && (
        <div className="fc-attachments">
          {props.attachments.map((attachment, index) => (
            <div className="fc-attachment" key={index}>
              {attachment.mediaType.startsWith("image/") ? (
                <img
                  alt={t("composer.attachment")}
                  src={`data:${attachment.mediaType};base64,${attachment.data}`}
                />
              ) : (
                <span>{attachment.name || t("composer.audio")}</span>
              )}
              <button
                type="button"
                aria-label={t("composer.remove")}
                onClick={() => props.onRemove(index)}
              >
                <ChatIcon name="close" />
              </button>
            </div>
          ))}
        </div>
      )}
      {!!commands.length && (
        <div
          className="fc-commands"
          role="listbox"
          id={`${id}-commands`}
          aria-label={t("composer.commands")}
        >
          {commands.map((command, index) => (
            <button
              type="button"
              id={`${id}-command-${index}`}
              role="option"
              aria-selected={index === commandAt}
              key={command.name}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pickCommand(command.name)}
            >
              <strong>/{command.name}</strong>
              <span>{command.description}</span>
            </button>
          ))}
        </div>
      )}
      {props.quote && (
        <div className="fc-quote-preview">
          <ChatIcon name="quote" />
          <div><span>{t("composer.quote")}</span><p>{props.quote}</p></div>
          <button type="button" className="fc-icon-button" aria-label={t("composer.removeQuote")} title={t("composer.removeQuote")} onClick={props.onRemoveQuote}><ChatIcon name="close" /></button>
        </div>
      )}
      <textarea
        ref={editor}
        value={props.draft}
        rows={2}
        aria-label={t("composer.message")}
        placeholder={t("composer.placeholder")}
        aria-controls={commands.length ? `${id}-commands` : undefined}
        aria-activedescendant={
          commands.length ? `${id}-command-${commandAt}` : undefined
        }
        onChange={(event) => { historyBrowse.current = null; props.onDraft(event.target.value); }}
        onPaste={(event) => {
          if (event.clipboardData.files.length) {
            event.preventDefault();
            props.onFiles(Array.from(event.clipboardData.files));
          }
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (historyBrowse.current && historyBrowse.current.text !== props.draft) historyBrowse.current = null;
          if (!speechBusy && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
              && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
            let browsing = historyBrowse.current;
            if (!browsing && event.key === 'ArrowUp' && props.draft === '' && props.history?.length) {
              const items = props.history.filter(text => text.trim());
              if (items.length) browsing = { items, index: items.length, text: '' };
            }
            if (browsing) {
              event.preventDefault(); event.stopPropagation();
              browsing.index = Math.max(0, Math.min(browsing.items.length, browsing.index + (event.key === 'ArrowUp' ? -1 : 1)));
              browsing.text = browsing.items[browsing.index] ?? '';
              historyBrowse.current = browsing.index === browsing.items.length ? null : browsing;
              props.onDraft(browsing.text);
              return;
            }
          }
          if (commands.length) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setCommandIndex(
                (commandAt +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  commands.length) %
                  commands.length,
              );
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setDismissedCommand(props.draft);
              return;
            }
            if (
              (event.key === "Enter" &&
                !event.metaKey &&
                !event.ctrlKey &&
                !event.shiftKey) ||
              event.key === "Tab"
            ) {
              event.preventDefault();
              pickCommand(commands[commandAt].name);
              return;
            }
          }
          if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
            event.preventDefault();
            if (!speechBusy && !props.sending
                && (props.draft.trim() || props.attachments.length))
              props.onSend();
          }
        }}
      />
      <div className="fc-toolbar" data-dictating={speechBusy}>
        <div className="fc-toolbar-left">
          <>
            <button
              type="button"
              className="fc-icon-button"
              title={t("composer.add")}
              aria-label={t("composer.add")}
              {...triggerProps("add")}
              onClick={(event) => open(event, "add")}
            >
              <ChatIcon name="plus" />
            </button>
            <input
              ref={file}
              hidden
              tabIndex={-1}
              type="file"
              multiple
              accept={[
                ".txt,.md,.csv,.json,.jsonl,.yaml,.yml,.toml,.xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.rs,.go,.c,.h,.cpp,.java,.sh,.sql,.log",
                props.capabilities?.image && "image/*",
                props.capabilities?.audio && "audio/*",
              ]
                .filter(Boolean)
                .join(",")}
              onChange={(event) => {
                const files = Array.from(event.target.files || []);
                event.target.value = "";
                if (files.length) props.onFiles(files);
              }}
            />
          </>
          {config.direct.map((option) => (
            <button
              type="button"
              className="fc-text-button"
              data-permission={permissionStyle(choices(option).find(c => c.value === option.currentValue)).tone}
              key={option.id}
              disabled={locked}
              title={acpOptionLabel(option, t)}
              aria-label={acpOptionLabel(option, t)}
              aria-haspopup="dialog"
              aria-expanded={panel?.option?.id === option.id}
              onClick={(event) => open(event, "config", option)}
            >
              {option.category === "mode" && <ChatIcon name={permissionStyle(choices(option).find(c => c.value === option.currentValue)).icon} />}
              <span>{name(option)}</span>
              <ChatIcon name="chevron" />
            </button>
          ))}
          {planEnabled && defaultChoice && <span className="fc-mode-chip"><ChatIcon name="plan"/><span>{t("composer.plan")}</span><button type="button" disabled={locked} aria-label={t("composer.exitPlan")} title={t("composer.exitPlan")} onClick={()=>choose(config.planning!,defaultChoice.value)}><ChatIcon name="close"/></button></span>}
          {(!!config.extra.length || props.onHostAccess) && (
            <button
              type="button"
              className="fc-icon-button"
              title={t("acp.controls.more")}
              aria-label={t("acp.controls.more")}
              {...triggerProps("extra")}
              onClick={(event) => open(event, "extra")}
            >
              <ChatIcon name="more" />
            </button>
          )}
        </div>
        <div className="fc-toolbar-right">
          <button
            type="button"
            className="fc-icon-button"
            title={contextTitle}
            aria-label={contextTitle}
            {...triggerProps("usage")}
            onClick={(event) => open(event, "usage")}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
              <circle
                className="fc-ring-track"
                cx="12"
                cy="12"
                r="8"
                fill="none"
                strokeWidth="2.5"
              />
              {ratio !== undefined ? (
                <circle
                  className="fc-ring-fill"
                  cx="12"
                  cy="12"
                  r="8"
                  fill="none"
                  strokeWidth="2.5"
                  pathLength="100"
                  strokeDasharray={`${ratio * 100} 100`}
                  transform="rotate(-90 12 12)"
                />
              ) : (
                <circle cx="12" cy="12" r="1" fill="currentColor" />
              )}
            </svg>
          </button>
          {(config.model || config.effort || config.fast) && (
            <button
              type="button"
              className="fc-model-button"
              aria-label={t("composer.modelSettings")}
              {...triggerProps("model")}
              onClick={(event) => open(event, "model")}
            >
              {config.model && <span>{name(config.model)}</span>}
              {config.effort && (
                <span className="fc-model-effort">{name(config.effort)}</span>
              )}
              <ChatIcon name="chevron" />
            </button>
          )}
          <SpeechInput ref={speech} active={props.active} onBusy={(_, phase) => setSpeechPhase(phase)} onTranscript={(text, sendImmediately) => {
            const draft = appendTranscript(props.draft, text);
            props.onDraft(draft);
            if (sendImmediately && !props.sending) props.onSend(draft);
            else editor.current?.focus();
          }} />
          <button
            type="button"
            className="fc-send"
            title={t(showStop ? (props.stopping ? "composer.stopping" : "composer.stop") : props.running ? "composer.queue" : "composer.send")}
            aria-label={t(showStop ? (props.stopping ? "composer.stopping" : "composer.stop") : props.running ? "composer.queue" : "composer.send")}
            disabled={
              (showStop ? props.stopping : (props.sending || (speechBusy ? speechPhase !== "recording" : (!props.draft.trim() && !props.attachments.length))))
            }
            onClick={() => { if (showStop) props.onStop(); else if (speechPhase === "recording") speech.current?.send(); else props.onSend(); }}
          >
            {showStop ? (
              <ChatIcon name="stop" />
            ) : props.sending ? (
              <span aria-hidden="true">…</span>
            ) : (
              <ChatIcon name={props.running ? "queue" : "send"} />
            )}
          </button>
        </div>
      </div>
      {panel && props.active && (
        <ComposerPanel
          updating={props.busy}
          anchor={panel.anchor}
          fullWidth={panel.kind === "add"}
          align={
            panel.kind === "model" || panel.kind === "usage"
              ? "center"
              : "start"
          }
          title={
            panel.kind === "add"
              ? t("composer.add")
              : panel.kind === "usage"
                ? t("acp.usage.context")
                : panel.kind === "model"
                  ? t("composer.modelSettings")
                  : currentOption
                    ? acpOptionLabel(currentOption, t)
                    : t("acp.controls.more")
          }
          onClose={close}
        >
          {panel.kind === "add" && (
            <div className="fc-add-menu">
              <div className="fc-panel-heading">{t("composer.add")}</div>
              <button
                type="button"
                className="fc-add-item"
                onClick={() => {
                  file.current?.click();
                  close(true);
                }}
              >
                <ChatIcon name="attachment" />
                <span>{t("composer.files")}</span>
                <small>{t("composer.fromDevice")}</small>
              </button>
              {config.planning && (planChoice && defaultChoice && planChoices.length === 2 ?
                <button type="button" className="fc-add-item" aria-pressed={planEnabled} disabled={locked}
                  onClick={() => choose(config.planning!, planEnabled ? defaultChoice.value : planChoice.value)}>
                  <ChatIcon name="plan"/><span>{t("composer.plan")}</span>
                  <small>{t(planEnabled ? "composer.planOn" : "composer.planHint")}</small>
                  {planEnabled && <ChatIcon name="check"/>}
                </button> : <section className="fc-add-planning"><div className="fc-panel-heading">{acpOptionLabel(config.planning,t)}</div><OptionList option={config.planning} disabled={locked} onChange={value=>choose(config.planning!,value)}/></section>)}
              {props.commands.length > 0 && (
                <>
                  <div className="fc-panel-heading">
                    {t("composer.commands")}
                  </div>
                  {props.commands.map((command) => (
                    <button
                      type="button"
                      className="fc-add-item"
                      key={command.name}
                      onClick={() => {
                        close();
                        props.onDraft(`/${command.name} `);
                        editor.current?.focus();
                      }}
                    >
                      <ChatIcon name="command" />
                      <span>/{command.name}</span>
                      {command.description && (
                        <small>{command.description}</small>
                      )}
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
          {panel.kind === "model" && (
            <div className="fc-model-panel">
              {config.model && (
                <>
                  <button
                    type="button"
                    className="fc-model-title"
                    aria-expanded={modelList}
                    onClick={() => setModelList((value) => !value)}
                  >
                    <span>{name(config.model)}</span>
                    <ChatIcon name="chevron" />
                  </button>
                  {modelList && (
                    <OptionList
                      option={config.model}
                      disabled={modelLocked}
                      onChange={(value) => choose(config.model!, value)}
                    />
                  )}
                </>
              )}
              {!config.effort && config.fast && <SpeedButton option={config.fast} disabled={modelLocked} onChange={value => choose(config.fast!, value)} />}
              {config.effort && (
                <DiscreteSlider
                  action={config.fast && <SpeedButton option={config.fast} disabled={modelLocked} onChange={value => choose(config.fast!, value)} />}
                  labels={choices(config.effort).map((choice) =>
                    acpChoiceLabel(config.effort!, choice.name, t),
                  )}
                  value={choices(config.effort).findIndex(
                    (choice) => choice.value === config.effort!.currentValue,
                  )}
                  disabled={modelLocked}
                  title={t("acp.controls.thinking")}
                  onCommit={(index) =>
                    choose(config.effort!, choices(config.effort!)[index].value)
                  }
                />
              )}
            </div>
          )}
          {panel.kind === "usage" && (
            <UsageDetails context={props.context} usage={props.usage}
              onCompact={props.onCompact && props.commands.some(command => command.name.replace(/^\//, '') === 'compact') ? () => { close(); props.onCompact?.(); } : undefined}
              compactDisabled={locked || props.sending || speechBusy} />
          )}
          {panel.kind === "config" && currentOption && (
            <>
              <div className="fc-panel-heading">
                {acpOptionLabel(currentOption, t)}
              </div>
              <OptionList
                option={currentOption}
                disabled={locked}
                onChange={(value) => choose(currentOption, value)}
              />
            </>
          )}
          {panel.kind === "extra" && props.onHostAccess && <section className="fc-extra-section">
            <div className="fc-panel-heading">{t('acp.host.title')}</div>
            <p className="fc-host-hint">{t('acp.host.description')}</p>
            <button type="button" className="fc-text-button" role="switch" aria-checked={props.hostAccess === true}
              disabled={locked || props.sending} onClick={() => props.onHostAccess?.(!props.hostAccess)}>
              <ChatIcon name={props.hostAccess ? 'check' : 'shield'}/><span>{t(props.hostAccess ? 'acp.host.enabled' : 'acp.host.disabled')}</span>
            </button>
          </section>}
          {panel.kind === "extra" &&
            config.extra.map((option) => (
              <section className="fc-extra-section" key={option.id}>
                <div className="fc-panel-heading">
                  {acpOptionLabel(option, t)}
                </div>
                <OptionList
                  option={option}
                  disabled={locked}
                  onChange={(value) => choose(option, value)}
                />
              </section>
            ))}
        </ComposerPanel>
      )}
    </div>
  );
}

export function SpeedButton({
  option,
  disabled,
  onChange,
}: {
  option: Config;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const tooltipId = useId();
  const { t } = useI18n(),
    pair = fastPair(option);
  if (!pair)
    return (
      <OptionList option={option} disabled={disabled} onChange={onChange} />
    );
  const enabled = option.currentValue === pair.on.value;
  return (
    <span className="fc-speed-control">
    <button
      type="button"
      className="fc-icon-button fc-speed"
      aria-label={t("acp.controls.fast")}
      aria-pressed={enabled}
      aria-describedby={tooltipId}
      disabled={disabled}
      onClick={() => onChange(enabled ? pair.off.value : pair.on.value)}
    >
      <ChatIcon name="bolt" />
    </button>
    <span id={tooltipId} role="tooltip" className="fc-speed-tooltip">{t("acp.controls.fast")}</span>
    </span>
  );
}
function OptionList({
  option,
  disabled,
  onChange,
}: {
  option: Config;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const all = choices(option);
  return (
    <div
      className="fc-option-list"
      role="radiogroup"
      aria-label={acpOptionLabel(option, t)}
      onKeyDown={(event) => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
          return;
        const buttons = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ),
        );
        if (!buttons.length) return;
        event.preventDefault();
        event.stopPropagation();
        const index = buttons.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        buttons[
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : (index +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  buttons.length) %
                buttons.length
        ].focus();
      }}
    >
      {all.map((choice, index) => (
        <div key={choice.value}>
          {choice.group && choice.group !== all[index - 1]?.group && (
            <div className="fc-panel-heading">{choice.group}</div>
          )}
          <button
            type="button"
            role="radio"
            aria-checked={choice.value === option.currentValue}
            disabled={disabled}
            onClick={() => onChange(choice.value)}
          >
            <span className="fc-option-name" data-permission={option.category === "mode" ? permissionStyle(choice).tone : undefined}>
              {option.category === "mode" && <ChatIcon name={permissionStyle(choice).icon} />}
              {acpChoiceLabel(option, choice.name, t)}
            </span>
            {choice.value === option.currentValue && <ChatIcon name="check" />}
          </button>
        </div>
      ))}
    </div>
  );
}
function UsageDetails({
  context,
  usage,
  onCompact,
  compactDisabled,
}: {
  context?: ContextUsage;
  usage?: Usage;
  hostAccess?: boolean;
  onHostAccess?: (enabled: boolean) => void;
  onCompact?: () => void;
  compactDisabled?: boolean;
}) {
  const { t } = useI18n(),
    ratio = contextRatio(context);
  const keys = [
    "inputTokens",
    "outputTokens",
    "cachedReadTokens",
    "cachedWriteTokens",
    "thoughtTokens",
    "totalTokens",
  ] as const;
  const hitRate = cacheHitRatio(usage);
  const rows = keys.filter((key) => finite(usage?.cumulative?.[key]));
  return (
    <div className="fc-usage">
      {onCompact && <div className="fc-usage-actions"><button type="button" className="fc-text-button" disabled={compactDisabled} onClick={onCompact}>{t('acp.usage.compact')}</button></div>}
      <header>
        <span>{t("acp.usage.context")}</span>
        <strong>
          {ratio === undefined ? "—" : `${Math.round(ratio * 100)}%`}
        </strong>
      </header>
      <p>
        {finite(context?.used) ? context.used.toLocaleString() : "—"} /{" "}
        {finite(context?.size) && context.size > 0
          ? context.size.toLocaleString()
          : "—"}{" "}
        tokens
      </p>
      {ratio === undefined && <small>{t("acp.usage.unknown")}</small>}
      <dl>
        <div title={t("acp.usage.cacheFormula")}>
          <dt>{t("acp.usage.cacheHit")}</dt>
          <dd>
            {hitRate === undefined ? "—" : `${(hitRate * 100).toFixed(1)}%`}
          </dd>
        </div>
      </dl>
      {!!rows.length && (
        <>
          <h4>{t("acp.usage.cumulative")}</h4>
          <dl>
            {rows.map((key) => (
              <div key={key}>
                <dt>{t(`acp.usage.${key}`)}</dt>
                <dd>{usage!.cumulative![key]!.toLocaleString()}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      {finite(usage?.cost?.amount) && (
        <dl>
          <div>
            <dt>{t("acp.usage.cost")}</dt>
            <dd>
              {usage!.cost!.amount!.toLocaleString(undefined, {
                maximumFractionDigits: 6,
              })}{" "}
              {usage?.cost?.currency}
            </dd>
          </div>
        </dl>
      )}
    </div>
  );
}
