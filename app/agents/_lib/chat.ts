import { type AgentRowLike, type MessageRowLike, type RunRowLike, partyName, tsMs } from './selectors';

// Pure view logic for the /agents chat room: runs become sessions, agent_message rows become chat
// bubbles (broadcasts merged, Ad Lab's word-for-word relays to the user folded into the original),
// and the logged summaries get a light, chattier rewrite. Display only: the rows stay as logged.

export const OPEN_CHAT = '__open__';

/** The name the room shows: "Ad Lab Strategist" reads as "Strategist" in a bubble or mention. */
export function roomName(id: string, agents: readonly AgentRowLike[] = []): string {
  const name = partyName(id, agents);
  return id === 'agt_ad_lab' ? name : name.replace(/^Ad Lab (?=\S)/, '');
}

/** A message without a run id joins the next run that starts within this window after it. */
const ATTACH_WINDOW_MS = 30 * 60_000;
const BROADCAST_WINDOW_MS = 2_000;
const RELAY_WINDOW_MS = 5_000;

export interface ChatSession {
  id: string;
  runId: string | null;
  label: string;
  startMs: number;
  lastMs: number;
  preview: string;
  count: number;
}

/** Each message's session: its run, or for run-less messages the next run starting soon after. */
export function sessionIds(messages: readonly MessageRowLike[], runs: readonly RunRowLike[] = []): Map<string, string> {
  const starts = new Map<string, number>();
  const bump = (id: string, ms: number) => starts.set(id, Math.min(starts.get(id) ?? ms, ms));
  for (const r of runs) bump(r.runId, tsMs(r.createdAt));
  for (const m of messages) if (m.runId) bump(m.runId, tsMs(m.createdAt));
  const ordered = [...starts].sort((a, b) => a[1] - b[1]);

  const out = new Map<string, string>();
  for (const m of messages) {
    if (m.runId) {
      out.set(m.messageId, m.runId);
      continue;
    }
    const at = tsMs(m.createdAt);
    const next = ordered.find(([, start]) => start >= at && start - at <= ATTACH_WINDOW_MS);
    out.set(m.messageId, next ? next[0] : OPEN_CHAT);
  }
  return out;
}

/** "Oct 25 · 09:03" in the viewer's time zone. */
export function sessionLabel(ms: number): string {
  const d = new Date(ms);
  const month = d.toLocaleString('en-US', { month: 'short' });
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${month} ${d.getDate()} · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Sessions with at least one message, newest activity first. */
export function chatSessions(
  messages: readonly MessageRowLike[],
  ids: Map<string, string>,
  agents: readonly AgentRowLike[] = [],
): ChatSession[] {
  const byId = new Map<string, MessageRowLike[]>();
  for (const m of messages) {
    const id = ids.get(m.messageId) ?? OPEN_CHAT;
    byId.set(id, [...(byId.get(id) ?? []), m]);
  }
  return [...byId]
    .map(([id, rows]) => {
      const sorted = [...rows].sort((a, b) => tsMs(a.createdAt) - tsMs(b.createdAt));
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const startMs = tsMs(first.createdAt);
      const line = chatText(last.summary);
      return {
        id,
        runId: id === OPEN_CHAT ? null : id,
        label: id === OPEN_CHAT ? 'Open chat' : `Run · ${sessionLabel(startMs)}`,
        startMs,
        lastMs: tsMs(last.createdAt),
        preview: `${roomName(last.fromAgent, agents)}: ${line.card ?? line.text}`,
        count: rows.length,
      };
    })
    .sort((a, b) => b.lastMs - a.lastMs || b.id.localeCompare(a.id));
}

export interface ChatBubble {
  id: string;
  runId: string;
  from: string;
  fromName: string;
  /** Recipients' ids; more than one when the sender broadcast the same line. */
  to: string[];
  toNames: string[];
  kind: string;
  protocol: string;
  summary: string;
  payload: string;
  createdMs: number;
  text: string;
  card: string | null;
  /** Names of parties Ad Lab relayed this line to, word for word. */
  forwardedTo: string[];
}

/** One session's bubbles, oldest first. */
export function chatThread(
  messages: readonly MessageRowLike[],
  ids: Map<string, string>,
  sessionId: string | null,
  agents: readonly AgentRowLike[] = [],
): ChatBubble[] {
  const rows = messages
    .filter((m) => sessionId != null && (ids.get(m.messageId) ?? OPEN_CHAT) === sessionId)
    .sort((a, b) => tsMs(a.createdAt) - tsMs(b.createdAt) || a.messageId.localeCompare(b.messageId));

  const out: ChatBubble[] = [];
  for (const m of rows) {
    const at = tsMs(m.createdAt);
    const prev = out[out.length - 1];
    if (prev && prev.from === m.fromAgent && prev.summary === m.summary && at - prev.createdMs <= BROADCAST_WINDOW_MS && !prev.to.includes(m.toAgent)) {
      prev.to.push(m.toAgent);
      prev.toNames.push(roomName(m.toAgent, agents));
      continue;
    }
    if (m.fromAgent === 'agt_ad_lab') {
      const original = out
        .slice(-6)
        .reverse()
        .find((b) => b.summary === m.summary && b.to.includes('agt_ad_lab') && at - b.createdMs <= RELAY_WINDOW_MS);
      if (original) {
        const name = roomName(m.toAgent, agents);
        if (!original.forwardedTo.includes(name)) original.forwardedTo.push(name);
        continue;
      }
    }
    const { text, card } = chatText(m.summary);
    out.push({
      id: m.messageId,
      runId: m.runId,
      from: m.fromAgent,
      fromName: roomName(m.fromAgent, agents),
      to: [m.toAgent],
      toNames: [roomName(m.toAgent, agents)],
      kind: m.kind,
      protocol: m.protocol,
      summary: m.summary,
      payload: m.payload,
      createdMs: at,
      text,
      card,
      forwardedTo: [],
    });
  }
  return out;
}

/** Internal ids and jargon out of a line meant for the room. */
export function tidy(text: string): string {
  return text
    .replace(/@agent1[a-z0-9]+\s*/g, '')
    .replace(/\btsk_run_\S+?_r(\d+)\b/g, 'round $1')
    .replace(/\btsk_[a-z0-9_]+\b/g, 'the next task')
    .replace(/^(?:run )?run_[a-z0-9_]+ done$/, 'Run finished')
    .replace(/\b(?:run )?run_[a-z0-9_]+\b/g, 'the run')
    .replace(/\b(?:plan )?plan_[a-f0-9]+\b/g, 'the plan')
    .replace(/\s*\(adlab-[a-z0-9-]+\)/g, '')
    .replace(/\bB's sim worker\b/g, 'The simulator')
    .trim();
}

const plural = (n: string, word: string) => `${n} ${word}${n === '1' ? '' : 's'}`;

type Rule = [RegExp, (...groups: string[]) => string];

// First match wins, tried against the summary with agent addresses stripped. Patterns follow the
// summaries agents/*.py log (send_logged / send_chat calls).
const RULES: Rule[] = [
  [/^Intel request: (.+)$/s, (ask) => `New ask from the user: "${ask}". Can you pull fresh intel?`],
  [/^Plan request: (.+)$/s, (ask) => `Intel's in. Can you draft test recipes for "${ask}"?`],
  [
    /^Intel: (\d+) pains, (\d+) competitor winners; refresh (\d+) picked, (\d+) jobs \((\w+)\)$/,
    (pains, winners, picked, _jobs, mode) =>
      `Here's the intel: ${plural(pains, 'customer pain')} and ${plural(winners, 'competitor ad')} that are winning. ` +
      `Refreshing ${plural(picked, 'stale source')}${mode === 'test' ? ' (test mode, so dry runs)' : ''}.`,
  ],
  [/^Intel: (.+)$/s, (rest) => `Here's the intel: ${rest}`],
  [
    /^Plan \S+: (\d+) recipes \+ control, (\d+) rounds, \S+(?: \(blocked: (.+)\))?$/,
    (n, rounds, blocked) => `Plan's ready: ${plural(n, 'ad recipe')} plus a control, tested over ${plural(rounds, 'round')}.${blocked ? ` Blocked for now: ${blocked}.` : ''}`,
  ],
  [/^User approved \S+: start \S+ \((\d+) rounds\)$/, (rounds) => `The user approved the plan. Kick off all ${plural(rounds, 'round')}.`],
  [/^Queued \S+ on \S+ \((\d+) rounds\)$/, (rounds) => `On it. The warm-up round is queued, ${plural(rounds, 'round')} to follow.`],
  [/^Run \S+ started: watch its creative tasks$/, () => "We're live. Watch the task board and write fresh ads after every round."],
  [/^Run \S+ done: (\d+) winners?, (\d+) leaders?$/, (w, l) => `That's a wrap: ${plural(w, 'winner')} and ${plural(l, 'leader')}.`],
  [/^Run \S+ not started: (.+)$/s, (error) => `Couldn't start the run: ${error}`],
  [/^Round (\d+) creatives: (\d+) written, (\d+) ranked; next \S+$/, (r, w) => `Round ${r} ads are in: ${w} written and ranked. Next round is queued.`],
  [/^Status: (.+)$/s, (line) => line],
];

/** The bubble text for a logged summary, or the card title when it announces a card. */
export function chatText(summary: string): { text: string; card: string | null } {
  const raw = summary.replace(/@agent1[a-z0-9]+\s*/g, '').trim();
  const card = raw.match(/^Card(?: again)?: (.+)$/s);
  if (card) return { text: '', card: card[1] };
  if (raw.startsWith('{')) {
    try {
      const action = JSON.parse(raw) as { action?: string; approved?: boolean };
      if (action.action === 'start_run') return { text: action.approved === false ? 'Not yet, hold the run.' : 'Looks good, approved. Start the run!', card: null };
      if (action.action) return { text: tidy(action.action.replace(/_/g, ' ')), card: null };
    } catch {
      // Not JSON after all: falls through to the rules.
    }
  }
  for (const [re, render] of RULES) {
    const m = raw.match(re);
    if (m) return { text: tidy(render(...m.slice(1))), card: null };
  }
  return { text: tidy(raw), card: null };
}

/** Wait before each bubble in a replay: the real gaps, clamped so it neither drags nor blurs. */
export function replayDelays(bubbles: readonly Pick<ChatBubble, 'createdMs'>[], speed = 1): number[] {
  return bubbles.map((b, i) => {
    const gap = i === 0 ? 800 : b.createdMs - bubbles[i - 1].createdMs;
    return Math.round(Math.min(2500, Math.max(500, gap)) / speed);
  });
}

/** Initials avatar colours per party. */
export const PARTY_STYLE: Record<string, { initials: string; className: string }> = {
  agt_ad_lab: { initials: 'AL', className: 'bg-violet-500/15 text-violet-300 ring-violet-500/30' },
  agt_scout: { initials: 'SC', className: 'bg-amber-500/15 text-amber-300 ring-amber-500/30' },
  agt_strategist: { initials: 'ST', className: 'bg-sky-500/15 text-sky-300 ring-sky-500/30' },
  agt_copywriter: { initials: 'CW', className: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30' },
  user: { initials: 'You', className: 'bg-secondary text-foreground ring-border' },
};

export function partyStyle(id: string): { initials: string; className: string } {
  return PARTY_STYLE[id] ?? { initials: id.replace(/^agt_/, '').slice(0, 2).toUpperCase(), className: 'bg-secondary text-muted-foreground ring-border' };
}

/** The mention chip colour: the party's avatar text colour. */
export function mentionClass(id: string): string {
  return partyStyle(id).className.split(' ').find((c) => c.startsWith('text-')) ?? 'text-foreground';
}
