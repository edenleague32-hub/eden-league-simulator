// Private DM — user-controlled manager texting another manager or a player on
// their own roster. AI replies in character; tone is scored in the same call
// so morale/relations can be updated client-side without a second round trip.
import { createServerFn } from "@tanstack/react-start";

const GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";
const MODEL = "google/gemini-3-flash-preview";

export type Counterpart = "manager" | "player" | "team";
export interface DmTurn { role: "user" | "ai"; text: string; }

interface DmInput {
  userTeam: string;          // user's club
  userManagerName: string;   // user's own manager name (if any)
  kind: Counterpart;
  counterpartTeam: string;   // for manager DMs = AI club; for player DMs = the user's own club
  counterpartName: string;   // the recipient (manager or player)
  counterpartPersonality?: string; // manager personality (DMs with managers only)
  brief: string;             // factual brief built on the client
  history: DmTurn[];
  userMessage: string;       // the user's latest message — empty when `initiate` is true
  initiate?: boolean;        // when true, the AI is opening the conversation unprompted
}

function extractJson<T>(s: string): T | null {
  const a = s.indexOf("{"); const b = s.lastIndexOf("}");
  if (a < 0 || b < a) return null;
  try { return JSON.parse(s.slice(a, b + 1)) as T; } catch { return null; }
}

async function callGateway(apiKey: string, system: string, user: string, temperature = 0.9) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(GATEWAY, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL, temperature,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
      signal: ctrl.signal,
    });
    if (res.status === 429) throw new Error("RATE_LIMIT");
    if (res.status === 402) throw new Error("CREDITS");
    if (!res.ok) throw new Error(`AI request failed (${res.status})`);
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return json.choices?.[0]?.message?.content?.trim() ?? "";
  } finally { clearTimeout(t); }
}

const MANAGER_DM_RULES = `
You are an AI manager in the Eden League texting privately with another club's manager (the USER). Stay in character.

ABSOLUTE RULES:
- Use ONLY facts in the BRIEF. Never invent players, ratings, results, or money.
- Keep replies SHORT — 1-3 short sentences, conversational text-message tone.
- Your tolerance and behavior follow your PERSONALITY, tempered by how warm the relationship feels in this conversation.
- The user might be friendly, professional, prickly, or trying to bait you. Match the tone realistically — don't be a doormat AND don't be needlessly hostile.

OUTPUT FORMAT — JSON object exactly:
{"reply":"<your text message>","tone":<integer -3..3>,"userTone":<integer -3..3>}
- "tone": how friendly YOUR reply is (-3 = hostile, 0 = neutral, +3 = warm).
- "userTone": how friendly the USER's latest message was (your read of it).
No markdown, no extra text.
`;

const PLAYER_DM_RULES = `
You are a player on the user's own club, texting privately with your own manager (the USER). Stay in character: a young pro talking to your gaffer.

ABSOLUTE RULES:
- Use ONLY facts in the BRIEF. Never invent stats, contracts, transfers, or events.
- Keep replies SHORT — 1-3 short sentences, conversational text-message tone.
- React naturally to how the manager talks to you: praise lifts your mood; criticism, threats, or dismissal sting; balanced honesty is respected.

OUTPUT FORMAT — JSON object exactly:
{"reply":"<your text message>","tone":<integer -3..3>,"userTone":<integer -3..3>}
- "tone": how YOUR reply reads (-3 = upset / bitter, 0 = neutral, +3 = happy / motivated).
- "userTone": how the manager's latest message felt to you (-3 = harsh, +3 = supportive).
No markdown, no extra text.
`;

export const sendDm = createServerFn({ method: "POST" })
  .inputValidator((d: DmInput) => {
    if (!d) throw new Error("Empty payload");
    if (d.kind !== "manager" && d.kind !== "player") throw new Error("Invalid counterpart kind");
    if (!d.initiate && (typeof d.userMessage !== "string" || d.userMessage.trim().length === 0)) {
      throw new Error("Empty message");
    }
    return d;
  })
  .handler(async ({ data }): Promise<{ reply: string; tone: number; userTone: number }> => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("AI is not configured");
    const rules = data.kind === "manager" ? MANAGER_DM_RULES : PLAYER_DM_RULES;
    const persona = data.kind === "manager"
      ? `You are ${data.counterpartName}, manager of ${data.counterpartTeam}.\nYOUR PERSONALITY: ${data.counterpartPersonality ?? "Balanced, professional."}`
      : `You are ${data.counterpartName}, a player on ${data.counterpartTeam} (the user's own club).`;
    const userBlock = (data.userManagerName && data.userManagerName.toUpperCase() !== "USER CONTROLLED")
      ? `The user is ${data.userManagerName}, manager of ${data.userTeam}.`
      : `The user is the manager of ${data.userTeam}.`;
    const history = data.history.length
      ? data.history.map((h) => `${h.role === "user" ? "MANAGER" : "YOU"}: ${h.text}`).join("\n")
      : "(no prior messages — this is the start of the conversation)";
    const tail = data.initiate
      ? `THE MANAGER HAS NOT MESSAGED YOU. You're texting them first, unprompted, because something on your mind made you reach out (recent results, the relationship, your situation). Open the conversation in 1-2 short sentences. Set "userTone" to 0 (they haven't said anything yet). Reply in JSON only.`
      : `MANAGER'S LATEST MESSAGE: ${data.userMessage}\n\nReply now in JSON only.`;
    const user = [
      `BRIEF (only facts you may use):`,
      data.brief,
      ``,
      userBlock,
      ``,
      `CONVERSATION SO FAR:`,
      history,
      ``,
      tail,
    ].join("\n");
    const content = await callGateway(key, persona + "\n" + rules, user);
    const parsed = extractJson<{ reply?: unknown; tone?: unknown; userTone?: unknown }>(content);
    const reply = parsed && typeof parsed.reply === "string" ? parsed.reply.trim() : content.trim() || "…";
    const tone = clampInt(parsed?.tone, 3);
    const userTone = clampInt(parsed?.userTone, 3);
    return { reply, tone, userTone };
  });

function clampInt(v: unknown, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-max, Math.min(max, Math.round(n)));
}

// Team Chat — manager-only broadcast to their own dressing room. We only ask
// the AI to SCORE the manager's message (no per-player reply text), then apply
// the result to every player's morale + the manager's own respect rating.
// One small AI call per team post → cheap even with heavy use.
interface TeamScoreInput {
  userTeam: string;
  userManagerName: string;
  squadBrief: string; // short factual brief about the squad / standing
  history: DmTurn[];
  userMessage: string;
}

const TEAM_SCORE_RULES = `
You read a private dressing-room message from a football manager to their entire squad and score how it would land.

ABSOLUTE RULES:
- Use ONLY the BRIEF for facts. Do NOT generate any player reply text.
- Score honestly: praise and clear, fair leadership lift morale and earn respect; vague positivity is neutral; insults, blame, threats, public shaming, or panic LOWER morale AND respect.
- Sarcasm directed at the squad counts as harsh.

OUTPUT FORMAT — JSON object exactly, nothing else:
{"moraleTone":<integer -3..3>,"respectTone":<integer -3..3>}
- "moraleTone": how the average player would feel after reading it.
- "respectTone": how this message affects the squad's respect for the gaffer.
No markdown, no extra keys, no reply text.
`;

export const scoreTeamMessage = createServerFn({ method: "POST" })
  .inputValidator((d: TeamScoreInput) => {
    if (!d) throw new Error("Empty payload");
    if (typeof d.userMessage !== "string" || d.userMessage.trim().length === 0) {
      throw new Error("Empty message");
    }
    return d;
  })
  .handler(async ({ data }): Promise<{ moraleTone: number; respectTone: number }> => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("AI is not configured");
    const persona = `You are an impartial dressing-room observer for ${data.userTeam}. The manager is ${data.userManagerName}.`;
    const history = data.history.length
      ? data.history.slice(-6).map((h) => `MANAGER: ${h.text}`).join("\n")
      : "(no prior team messages)";
    const user = [
      `BRIEF (only facts you may use):`,
      data.squadBrief,
      ``,
      `RECENT TEAM MESSAGES:`,
      history,
      ``,
      `NEW TEAM MESSAGE: ${data.userMessage}`,
      ``,
      `Score it now in JSON only.`,
    ].join("\n");
    const content = await callGateway(key, persona + "\n" + TEAM_SCORE_RULES, user, 0.3);
    const parsed = extractJson<{ moraleTone?: unknown; respectTone?: unknown }>(content);
    return {
      moraleTone: clampInt(parsed?.moraleTone, 3),
      respectTone: clampInt(parsed?.respectTone, 3),
    };
  });
