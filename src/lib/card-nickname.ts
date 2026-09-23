export function nicknameHue(cardId: string) {
  let hash = 2166136261;
  for (let index = 0; index < cardId.length; index += 1) {
    hash ^= cardId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 360;
}
