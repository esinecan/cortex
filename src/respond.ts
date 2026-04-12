import type { StateManager } from './state.js';

export function success(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

export function error(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

/** Wrap a tool response with a location breadcrumb and optional CTA. */
export function respond(st: StateManager, body: string, next?: string) {
  const parts = [st.breadcrumb(), '', body];
  if (next) parts.push('', `**Next:** ${next}`);
  return success(parts.join('\n'));
}
