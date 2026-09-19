import { URGENT_CALL_TAG, URGENT_CALL_NAME, isReservedUrgentName, hasUrgentCall } from "./urgent-call.ts";
import { externalQueueCards, type QueueCard, type CardQueue } from "./card-queue.ts";
export interface TurnTag { name: string; weight: number; description: string }
export const DEFAULT_TURN_TAGS: TurnTag[] = [
  { name: "🧩 Easy", weight: 30, description: "The request only needs a simple confirmation, choice, short reply, or low-cost judgment; it does not require recalling and understanding substantial project context." },
  URGENT_CALL_TAG,
];
export function effectiveTurnTags(tags: TurnTag[]): TurnTag[] {
  return [...tags.filter(tag => !isReservedUrgentName(tag.name)), { ...URGENT_CALL_TAG }];
}
export function numericWeight(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1e6) throw new Error("权重必须是 -1000000 到 1000000 的有限数值");
  return value;
}
export function validateTags(value: unknown): TurnTag[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("Tag 列表无效");
  const names = new Set<string>();
  return value.map((tag) => {
    if (!tag || typeof tag.name !== "string" || !tag.name.trim() || tag.name.length > 100 || typeof tag.description !== "string" || !tag.description.trim() || tag.description.length > 4000) throw new Error("Tag 需要名称、数值权重和描述");
    const name = tag.name.trim();
    if (isReservedUrgentName(name) && name === URGENT_CALL_NAME && (tag.weight !== 0 || tag.description !== URGENT_CALL_TAG.description)) throw new Error("Urgent Call 是不可自定义的内置标签");
    if (names.has(name)) throw new Error("Tag 名称不能重复");
    names.add(name);
    return { name, weight: numericWeight(tag.weight), description: tag.description };
  });
}
export function validateTagResult(value: unknown, tags: TurnTag[]): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || !("tags" in value) || !Array.isArray(value.tags)) throw new Error("Tag 元数据必须是 {tags: []}");
  const names = value.tags;
  if (names.some((name) => typeof name !== "string" || !tags.some((tag) => tag.name === name)) || new Set(names).size !== names.length) throw new Error("返回了未定义或重复的 Tag");
  return names as string[];
}
export function scoreCard(card: QueueCard, tags: TurnTag[], now = Date.now()) {
  const waiting = card.readyAt === undefined ? 0 : Math.min(99, Math.max(0, Math.floor((now - (card.waitingSince ?? card.readyAt)) / 60000)));
  const matched = tags.filter(tag => tag.name !== URGENT_CALL_NAME && card.turnTags?.includes(tag.name));
  const weight = card.priorityWeight ?? 0;
  return { weight, waiting, tags: matched, total: weight + waiting + matched.reduce((sum, tag) => sum + tag.weight, 0) };
}
export function sortedQueue(state: CardQueue, now = Date.now(), includeExternal = false): QueueCard[] {
  const cards = state.order.flatMap((id) => {
    const card = state.cards.find((item) => item.id === id);
    return card && (card.session || card.harness) && !card.detached && card.archivedAt === undefined
      && card.remindAt === undefined && card.phase !== "working" ? [card] : [];
  });
  if (includeExternal) {
    // Merge the read-only overlay without persisting it or changing the relative
    // order of owned cards (which may have been manually moved).
    const newestFirst = state.insertionPosition === "top";
    const notices = externalQueueCards(state.external).sort((a, b) =>
      (newestFirst ? -1 : 1) * (a.readyAt! - b.readyAt!) || a.id.localeCompare(b.id));
    for (const notice of notices) {
      const index = cards.findIndex(card => newestFirst
        ? (card.readyAt ?? card.createdAt) < notice.readyAt!
        : (card.readyAt ?? card.createdAt) > notice.readyAt!);
      cards.splice(index < 0 ? cards.length : index, 0, notice);
    }
  }
  if (state.sortMode !== "score") return cards.sort((a,b) => Number(hasUrgentCall(b)) - Number(hasUrgentCall(a)));
  const tags = state.turnTagDefinitions ?? DEFAULT_TURN_TAGS;
  return cards.sort((a,b) => Number(hasUrgentCall(b)) - Number(hasUrgentCall(a))
    || scoreCard(b,tags,now).total - scoreCard(a,tags,now).total
    || (a.readyAt ?? a.createdAt) - (b.readyAt ?? b.createdAt)
    || a.id.localeCompare(b.id));
}
/** Resolve attention by identity without changing the scheduler's order.
 * If the card leaves the queue, continue at the nearest surviving slot.
 */
export function resolveQueueFocus(cards: QueueCard[], id: string | null, previousIndex = 0): number {
  const index = cards.findIndex((card) => card.id === id);
  return index >= 0 ? index : Math.max(0, Math.min(previousIndex, cards.length - 1));
}
