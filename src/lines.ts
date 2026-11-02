/**
 * Ghost cat lines from a Manyfold agent.
 *
 * Rules that keep this safe and cheap:
 *  - the agent only writes words. The board, the ghost's moves and the score never come from it.
 *  - one agent turn produces every line for a whole round, so a round bills at most one turn,
 *    and a cached set is reused for LINES_CACHE_SECONDS.
 *  - anything that does not parse is dropped; the browser keeps its built in lines for that key.
 */

export const LINE_KEYS = ['start', 'big', 'youLead', 'ghostLead', 'last', 'ghostWin', 'ghostLose', 'stuck'] as const;
export type LineKey = (typeof LINE_KEYS)[number];
export type Lang = 'hant' | 'hans' | 'en';
export const LANGS: Lang[] = ['hant', 'hans', 'en'];

export interface LinesRequest {
  ghostId: string;
  name: string;
  persona: string;
  lang: Lang;
}

const LANG_NAME: Record<Lang, string> = {
  hant: 'Traditional Chinese (Taiwan usage)',
  hans: 'Simplified Chinese (Mainland usage)',
  en: 'British English',
};

const MOMENT: Record<LineKey, string> = {
  start: 'the round starts',
  big: 'the ghost cat just cleared {n} cats in one box (keep the literal {n} placeholder)',
  youLead: 'the player has just overtaken the ghost cat',
  ghostLead: 'the ghost cat has just overtaken the player',
  last: 'ten seconds are left',
  ghostWin: 'the round ended and the ghost cat won',
  ghostLose: 'the round ended and the ghost cat lost',
  stuck: 'the ghost cat has no moves left on its board',
};

const MAX_LINE = 40;

/** Validates the browser's request. Returns null when it is not usable. */
export function parseRequest(raw: unknown): LinesRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const clean = (v: unknown, max: number) =>
    typeof v === 'string' ? v.replace(/[\u0000-\u001f<>{}`]/g, '').trim().slice(0, max) : '';
  const ghostId = clean(r.ghostId, 32);
  const name = clean(r.name, 24);
  const persona = clean(r.persona, 160);
  const lang = r.lang as Lang;
  if (!/^[a-z0-9_-]{1,32}$/i.test(ghostId) || !name || !LANGS.includes(lang)) return null;
  return { ghostId, name, persona, lang };
}

export function buildPrompt(req: LinesRequest): string {
  const moments = LINE_KEYS.map((k) => `- "${k}": when ${MOMENT[k]}`).join('\n');
  return [
    'You write short speech bubble lines for a ghost cat in a casual mobile puzzle game.',
    'In the game, players box groups of numbered cats that add up to 10. The ghost cat is a stand in for the player\'s friend and plays on the same board at the same time.',
    `The friend is called ${req.name}. Their personality: ${req.persona || 'playful'}.`,
    `Write in ${LANG_NAME[req.lang]}. Speak as the ghost cat, in the friend's voice, to the player.`,
    `Give 3 different lines for each moment below. Each line at most ${req.lang === 'en' ? 60 : 24} characters, friendly teasing only, no insults about real traits, no emoji.`,
    moments,
    'Reply with only one JSON object, no code fence and no other text. Keys are exactly the moment names, values are arrays of strings.',
  ].join('\n');
}

/** Pulls the first JSON object out of the agent's reply and keeps only well formed lines. */
export function parseLines(reply: string, lang: Lang): Partial<Record<LineKey, string[]>> | null {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const limit = lang === 'en' ? 90 : MAX_LINE;
  const out: Partial<Record<LineKey, string[]>> = {};
  for (const key of LINE_KEYS) {
    const v = (obj as Record<string, unknown>)[key];
    if (!Array.isArray(v)) continue;
    let lines = v
      .filter((x): x is string => typeof x === 'string')
      .map((x) => x.replace(/[\u0000-\u001f]/g, ' ').trim())
      .filter((x) => x.length > 0 && x.length <= limit);
    if (key === 'big') lines = lines.filter((x) => x.includes('{n}'));
    if (lines.length) out[key] = lines.slice(0, 5);
  }
  return Object.keys(out).length ? out : null;
}
