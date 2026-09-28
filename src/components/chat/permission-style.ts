import type { Choice } from './model';
// ACP session modes are provider-defined; names do not define permission scope.
export function permissionStyle(_choice?: Choice) {
  return { icon: 'shield' as const, tone: 'neutral' };
}
