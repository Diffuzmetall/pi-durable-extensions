// Adapted from disler/durable-pi @ 37165c619573dbaf425463038bbffecfe576beec.
// MIT, Copyright (c) 2026 IndyDevDan. See ../LICENSE.
import type { EntryRecord } from '@earendil-works/pi-durable';

export type HistoryKind = 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'event';
export interface HistoryQuery {
  query?: string;
  tool?: string;
  entry?: number;
  kind?: HistoryKind;
  from_entry?: number;
  to_entry?: number;
  order?: 'newest' | 'oldest';
  limit?: number;
  offset?: number;
}
export interface HistoryMarks { activeFrom?: number; latestMarker?: number; lastReset?: number }
interface Parsed { id: number; headMarker: boolean; kind: Exclude<HistoryKind, 'tool_call'>; tools: string[]; text: string }

const SEARCH_TOOL = 'search_history';
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;

// Only text and tool arguments: never thinking, images, signatures or arbitrary entry.data.
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('\n');
}

function parse(entry: EntryRecord): Parsed | undefined {
  if (entry.kind === 'pi.system') return;
  const messages = entry.model ?? [];
  const tools: string[] = [];
  const parts: string[] = [];
  let kind: Parsed['kind'] = 'event';
  if (entry.kind === 'pi.user') {
    kind = 'user';
    for (const message of messages) if (message.role === 'user') parts.push(textOf(message.content));
  } else if (entry.kind === 'pi.assistant') {
    kind = 'assistant';
    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      for (const block of message.content) {
        if (block.type === 'text') parts.push(block.text);
        if (block.type === 'toolCall') {
          tools.push(block.name);
          parts.push(`→ ${block.name} ${JSON.stringify(block.arguments ?? {})}`);
        }
      }
    }
  } else if (entry.kind === 'pi.tool-result') {
    kind = 'tool_result';
    for (const message of messages) {
      if (message.role !== 'toolResult') continue;
      tools.push(message.toolName);
      parts.push(`${message.toolName}${message.isError ? ' (error)' : ''}: ${textOf(message.content)}`);
    }
  } else {
    parts.push(entry.kind === 'pi.reset' ? 'New context started (reset or handoff).'
      : entry.kind === 'pi.compaction' ? 'Context compacted. Summary of older entries:' : entry.kind);
    for (const message of messages) if (message.role !== 'system') parts.push(textOf(message.content));
  }
  return { id: entry.id, headMarker: entry.head !== undefined, kind, tools, text: parts.join('\n').trim() };
}

/** Literal AND search over the supplied window; no index, I/O, storage writes or model calls. */
export function searchHistory(entries: readonly EntryRecord[], q: HistoryQuery, marks: HistoryMarks = {}) {
  const limit = Math.min(Math.max(Math.trunc(q.limit ?? 10), 1), 50);
  const offset = Math.max(Math.trunc(q.offset ?? 0), 0);
  const terms = (q.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const tool = q.tool?.trim().toLowerCase();
  // Filter cheap IDs before extracting text and serializing tool arguments.
  const parsed = entries.filter(entry => q.entry !== undefined ? entry.id === q.entry
    : (q.from_entry === undefined || entry.id >= q.from_entry)
      && (q.to_entry === undefined || entry.id <= q.to_entry))
    .flatMap(entry => parse(entry) ?? []);
  const matches = parsed.filter(p => {
    // Explicit entry lookup ignores search filters, matching the upstream contract.
    if (q.entry !== undefined) return true;
    if (tool !== SEARCH_TOOL && p.tools.length && p.tools.every(name => name === SEARCH_TOOL)) return false;
    if (tool && !p.tools.some(name => name.toLowerCase() === tool)) return false;
    if (q.kind === 'tool_call' && !(p.kind === 'assistant' && p.tools.length)) return false;
    if (q.kind && q.kind !== 'tool_call' && p.kind !== q.kind) return false;
    const text = p.text.toLowerCase();
    return terms.every(term => text.includes(term));
  }).sort((a, b) => q.order === 'oldest' ? a.id - b.id : b.id - a.id);
  const results = matches.slice(offset, offset + limit).map(p => {
    let context: 'active' | 'historical' | 'before reset' = 'active';
    if ((marks.activeFrom !== undefined && p.id < marks.activeFrom)
      || (p.headMarker && marks.latestMarker !== undefined && p.id !== marks.latestMarker)) {
      context = marks.lastReset !== undefined && p.id < marks.lastReset ? 'before reset' : 'historical';
    }
    const at = terms.length ? p.text.toLowerCase().indexOf(terms[0]) : 0;
    const start = q.entry !== undefined ? 0 : Math.max(0, at - 100);
    return {
      entry: p.id, kind: p.kind, context,
      ...(p.tools.length ? { tools: p.tools.slice(0, 20).map(name => clip(name, 80)), ...(p.tools.length > 20 ? { tools_truncated: true } : {}) } : {}),
      text: clip(`${start ? '…' : ''}${p.text.slice(start)}`, q.entry === undefined ? 360 : 4000),
    };
  });
  return {
    total: matches.length, offset, limit,
    next_offset: offset + results.length < matches.length ? offset + results.length : null,
    ...(marks.activeFrom === undefined ? {} : { active_from: marks.activeFrom }),
    results,
  };
}
