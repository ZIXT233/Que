export type Choice = { value: string; name: string; group?: string };
export type Config = {
  id: string;
  name: string;
  category?: string;
  currentValue: string;
  options: (Choice | { group: string; options: Choice[] })[];
};
export type Models = {
  currentModelId?: string;
  availableModelIds: string[];
  availableModels?: { modelId: string; name: string }[];
};
export type Attachment = { mediaType: string; data: string; name?: string };
export type Usage = {
  cumulative?: Partial<
    Record<
      | "inputTokens"
      | "outputTokens"
      | "cachedReadTokens"
      | "cachedWriteTokens"
      | "thoughtTokens"
      | "totalTokens",
      number
    >
  >;
  cost?: { amount?: number; currency?: string };
};
export type ContextUsage = { used?: number; size?: number };
export const choices = (option: Config): Choice[] =>
  option.options.flatMap((o) =>
    "group" in o && "options" in o
      ? o.options.map((c) => ({ ...c, group: o.group }))
      : [o as Choice],
  );
const normalize = (value: string) => value.toLowerCase().replace(/[ _-]/g, "");
export function role(option: Config) {
  const keys = [option.id, option.category || "", option.name].map(normalize);
  if (keys.some((k) => ["fast", "fastmode", "servicetier"].includes(k)))
    return "fast";
  if (keys.some((k) => ["collaboration", "collaborationmode"].includes(k)))
    return "collaboration";
  return option.category || "";
}
export function controls(options: Config[], legacy?: Models) {
  const model =
    options.find((o) => o.category === "model" && o.id === "model") ||
    options.find((o) => o.category === "model") ||
    options.find((o) => o.id === "model");
  const effort = options.find((o) => role(o) === "thought_level");
  const fast = options.find((o) => role(o) === "fast");
  const planning = options.find(o => role(o) === "collaboration");
  const direct = options.filter(o => role(o) === "mode" && o !== planning);
  return {
    model:
      model ||
      (legacy?.availableModelIds.length
        ? {
            id: "__legacy_model",
            name: "Model",
            category: "model",
            currentValue: legacy.currentModelId || "",
            options: legacy.availableModelIds.map((id) => ({
              value: id,
              name:
                legacy.availableModels?.find((m) => m.modelId === id)?.name ||
                id,
            })),
          }
        : undefined),
    effort,
    fast,
    planning,
    direct,
    extra: options.filter(
      (o) => o !== model && o !== effort && o !== fast && o !== planning && !direct.includes(o),
    ),
  };
}
export function fastPair(option: Config) {
  const all = choices(option);
  const match = (c: Choice, keys: string[]) =>
    [c.value, c.name].some((v) => keys.includes(v.toLowerCase()));
  const on = all.find((c) =>
    match(c, ["on", "true", "enabled", "fast", "priority"]),
  );
  const off = all.find((c) =>
    match(c, ["off", "false", "disabled", "default", "standard"]),
  );
  return all.length === 2 && on && off && on !== off ? { on, off } : undefined;
}
export const finite = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n) && n >= 0;
export function contextRatio(context?: ContextUsage) {
  return finite(context?.used) && finite(context?.size) && context.size > 0
    ? Math.min(1, context.used / context.size)
    : undefined;
}
export const THUMB = 28;
export function stepAt(
  clientX: number,
  left: number,
  width: number,
  count: number,
) {
  if (count < 2 || width <= THUMB) return 0;
  const ratio = Math.max(
    0,
    Math.min(1, (clientX - left - THUMB / 2) / (width - THUMB)),
  );
  return Math.round(ratio * (count - 1));
}

// acpx preserves provider counters: input may include or exclude cache tokens.
// Resolve the denominator only when the reported total confirms its meaning.
export function cacheHitRatio(usage?: Usage) {
  const u = usage?.cumulative;
  if (!u || !finite(u.inputTokens) || !finite(u.cachedReadTokens)
      || !finite(u.totalTokens) || !finite(u.outputTokens)
      || (u.cachedWriteTokens !== undefined && !finite(u.cachedWriteTokens))) return undefined;
  const input = u.totalTokens - u.outputTokens;
  const separateInput = u.inputTokens + u.cachedReadTokens + (u.cachedWriteTokens ?? 0);
  if (input <= 0 || u.cachedReadTokens > input
      || (input !== u.inputTokens && input !== separateInput)) return undefined;
  return u.cachedReadTokens / input;
}
