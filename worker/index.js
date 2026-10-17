// Psychometric showdown: a 1v1 quiz race. One Durable Object per room holds the game and its sockets.
import { DurableObject } from "cloudflare:workers";
import QUESTIONS from "./questions.json";

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 4;
const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);
const TOKEN_PATTERN = /^[A-Za-z0-9]{16,64}$/;
const SEATS = /** @type {const} */ (["a", "b"]);
const LIMITS = { target: [1, 50], grace: [3, 60], reading: [20, 600] };
/**
 * reading: seconds to read a passage before its questions. passages: false leaves passage questions out.
 * sections: the subjects that play, at least one.
 */
const DEFAULTS = { target: 10, grace: 15, reading: 120, passages: true, sections: ["verbal", "quantitative", "english"] };
const FIRST_COUNTDOWN_MS = 3000;
const NEXT_COUNTDOWN_MS = 1800;
const REVEAL_MS = 5500;
const IDLE_MS = 6 * 3600_000;
const NAME_MAX = 20;
const TAUNTS = ["😏", "😱", "🐢", "🔥", "🤡", "🫡", "💀", "🧠"];
const TAUNT_GAP_MS = 600;
// The bot copies the accuracy and speed of the human player, then leans against the score gap.
// The lean is capped, so a stronger player still wins more often.
const BOT = {
  name: "בוטי 🤖", token: "bot", startAccuracy: 0.6, startSpeedMs: 20_000, learnRate: 0.2,
  leanPerPoint: 0.04, maxLean: 0.15, minLevel: 0.2, maxLevel: 0.92, minDelayMs: 2500, maxDelayMs: 60_000,
  tauntChance: 0.4,
};
const IMPORT_MAX_QUESTIONS = 400;
const IMAGE_MAX_BYTES = 1_000_000;
const IMAGE_TYPES = ["image/webp", "image/png", "image/jpeg"];
const SECTIONS = ["verbal", "quantitative", "english"];
const CONTEXT_KINDS = ["passage", "chart"];
const IMAGE_CHOICES = ["1", "2", "3", "4"];
const NITE_ALL = "כל הבחינות של מאל\"ו";
const ASSET_ORIGIN = "https://assets.invalid";
const NITE_NOTICE = "השאלות הן מתוך נוסחי בחינות לדוגמה של המרכז הארצי לבחינות ולהערכה (מאל\"ו), בעל זכויות היוצרים. השימוש בחומרים נעשה באחריות המשתמש בלבד, ומאל\"ו אינו אחראי לדיוק או לנכונות של כל שינוי שייעשה או תוספת שתיעשה, אם תיעשה, כמו פתרונות או הסברים לשאלות.";

const BUILTIN_COUNTS = {};
for (const q of QUESTIONS) BUILTIN_COUNTS[q.section] = (BUILTIN_COUNTS[q.section] ?? 0) + 1;

// The page shows the choices of a question in this order, so the bank is checked once at load.
for (const [i, q] of QUESTIONS.entries()) {
  const ok = typeof q.id === "string" && typeof q.prompt === "string" && Array.isArray(q.choices) &&
    q.choices.length === 4 && Number.isInteger(q.answer) && q.answer >= 0 && q.answer < 4;
  if (!ok) throw new Error(`questions.json item ${i} is not valid`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/rooms" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const mode = body?.mode ?? "duel";
      if (mode !== "duel" && mode !== "bot") return Response.json({ error: "mode must be duel or bot" }, { status: 400 });
      // A random code can hit a live room. init refuses a used room, so retry with a new code.
      for (let attempt = 0; attempt < 8; attempt++) {
        const code = randomCode();
        if (await env.ROOMS.get(env.ROOMS.idFromName(code)).init(code, mode)) return Response.json({ code });
      }
      return Response.json({ error: "no free room code" }, { status: 503 });
    }
    // The NITE images are assets, but only a room may read them, one open round at a time.
    if (url.pathname.startsWith("/banks/")) return Response.json({ error: "not found" }, { status: 404 });
    const match = url.pathname.match(/^\/api\/rooms\/([^/]+)\/(ws|bank|image|context)$/);
    if (match) {
      const [, rawCode, route] = match;
      const code = rawCode.toUpperCase();
      if (!CODE_PATTERN.test(code)) return Response.json({ error: "bad room code" }, { status: 400 });
      if (route === "ws" && request.headers.get("Upgrade") !== "websocket") return new Response("expected a websocket", { status: 426 });
      return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(request);
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
};

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

function shuffled(length) {
  const order = Array.from({ length }, (_, i) => i);
  const rand = crypto.getRandomValues(new Uint32Array(length));
  for (let i = length - 1; i > 0; i--) {
    const j = rand[i] % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/**
 * @typedef {"a" | "b"} Seat
 * @typedef {"lobby" | "reading" | "countdown" | "question" | "reveal" | "over"} Phase
 * @typedef {{ choice: number, at: number }} Answer
 * @typedef {{ correct: number, tie: boolean, deltas: Record<Seat, number> }} Result
 * @typedef {{ number: number, q: number, openedAt: number | null, first: Seat | null,
 *   graceEndsAt: number | null, answers: Partial<Record<Seat, Answer>>, result: Result | null,
 *   context: string | null, ready: Record<Seat, boolean> | null }} Round
 * @typedef {{ kind: "builtin" } | { kind: "import", title: string } | { kind: "nite", id: string }} Source
 *   nite: one NITE public-use test from site/banks/manifest.json, or "all" of them.
 * @typedef {{ id: string, section: string, answer: number, context: string | null, contextKind: string | null, file: string | null }} Row
 *   file: the asset path of a NITE image. An imported image is in the room's SQL tables instead.
 * @typedef {{ code: string, settings: { target: number, grace: number, reading: number, passages: boolean, sections: string[] }, source: Source,
 *   seats: Record<Seat, { token: string, name: string } | null>, phase: Phase,
 *   scores: Record<Seat, number>, order: number[], cursor: number, round: Round | null,
 *   deadline: number | null, winner: Seat | null, idleSince: number | null, bot: Bot | null }} State
 * @typedef {{ accuracy: number, speedMs: number, plan: { at: number, choice: number } | null }} Bot
 * @typedef {{ token: string | null, seat: Seat | null, lastTaunt: number }} Attachment
 */

export class Room extends DurableObject {
  /** @type {State | null} */
  s = null;
  /** Messages that commit sends after the state. */
  outbox = [];
  /** @type {{ key: string, rows: Row[], contexts: Map<string, { kind: string, file: string | null }> } | null} */
  cache = null;
  /** @type {{ banks: any[] }} */
  manifest = { banks: [] };

  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.manifest = await loadManifest(env);
      this.s = (await ctx.storage.get("s")) ?? null;
      // A room saved by an older version lacks newer settings.
      if (this.s) this.s.settings = { ...DEFAULTS, ...this.s.settings };
      if (this.s && !this.s.source) this.s.source = this.s.bank ? { kind: "import", title: this.s.bank.title } : { kind: "builtin" };
    });
  }

  /** Returns false when the room already exists. In a bot room the bot holds seat b. */
  async init(code, mode) {
    if (this.s) return false;
    const bot = mode === "bot";
    this.s = {
      // A new room plays the real NITE tests when the build step made them, else the built-in set.
      code, settings: { ...DEFAULTS, sections: [...DEFAULTS.sections] },
      source: this.manifest.banks.length ? { kind: "nite", id: this.manifest.banks.length > 1 ? "all" : this.manifest.banks[0].id } : { kind: "builtin" },
      phase: "lobby",
      seats: { a: null, b: bot ? { token: BOT.token, name: BOT.name } : null },
      scores: { a: 0, b: 0 }, order: shuffled(QUESTIONS.length), cursor: 0, round: null,
      deadline: null, winner: null, idleSince: Date.now(),
      bot: bot ? { accuracy: BOT.startAccuracy, speedMs: BOT.startSpeedMs, plan: null } : null,
    };
    await this.commit();
    return true;
  }

  async fetch(request) {
    if (!this.s) return Response.json({ error: "no such room" }, { status: 404 });
    const route = new URL(request.url).pathname.split("/").pop();
    if (route === "bank" && request.method === "POST") return this.importBank(request);
    if (route === "bank" && request.method === "DELETE") return this.importBank(request, true);
    if (route === "image" && request.method === "GET") return this.roundImage(request);
    if (route === "context" && request.method === "GET") return this.contextImage(request);
    if (route !== "ws") return Response.json({ error: "not found" }, { status: 404 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment(/** @type {Attachment} */ ({ token: null, seat: null, lastTaunt: 0 }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, raw) {
    const s = this.s;
    if (!s) return ws.close(4404, "no such room");
    let msg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return send(ws, { t: "error", error: "bad json" });
    }
    /** @type {Attachment} */
    const me = ws.deserializeAttachment();
    const now = Date.now();
    const refuse = (error) => send(ws, { t: "error", error });

    switch (msg?.t) {
      case "hello": {
        if (typeof msg.token !== "string" || !TOKEN_PATTERN.test(msg.token)) return refuse("bad token");
        const name = typeof msg.name === "string" ? msg.name.trim().slice(0, NAME_MAX) : "";
        let seat = SEATS.find((x) => s.seats[x]?.token === msg.token) ?? null;
        if (!seat && s.phase === "lobby") seat = SEATS.find((x) => !s.seats[x]) ?? null;
        if (seat) s.seats[seat] = { token: msg.token, name: name || (seat === "a" ? "שחקן א" : "שחקן ב") };
        ws.serializeAttachment({ ...me, token: msg.token, seat });
        break;
      }
      case "settings": {
        if (me.seat !== "a") return refuse("only the host changes settings");
        if (s.phase !== "lobby" && s.phase !== "over") return refuse("settings are locked during a match");
        const next = { ...s.settings };
        if (msg.sections !== undefined) {
          const list = msg.sections;
          const ok = Array.isArray(list) && list.length > 0 && list.every((x) => SECTIONS.includes(x)) && new Set(list).size === list.length;
          if (!ok) return refuse("sections must be a list of at least one subject");
          next.sections = list;
        }
        if (msg.passages !== undefined) {
          if (typeof msg.passages !== "boolean") return refuse("passages must be true or false");
          next.passages = msg.passages;
        }
        for (const key of /** @type {const} */ (["target", "grace", "reading"])) {
          if (msg[key] === undefined) continue;
          const [min, max] = LIMITS[key];
          if (!Number.isInteger(msg[key]) || msg[key] < min || msg[key] > max) return refuse(`${key} must be ${min} to ${max}`);
          next[key] = msg[key];
        }
        s.settings = next;
        break;
      }
      case "start":
      case "rematch": {
        if (!me.seat) return refuse("spectators cannot start");
        if (!s.seats.a || !s.seats.b) return refuse("waiting for a second player");
        if (s.phase !== (msg.t === "start" ? "lobby" : "over")) return refuse(`cannot ${msg.t} now`);
        const order = this.buildOrder();
        if (!order.length) return refuse("אין שאלות בנושאים שנבחרו. בחרו עוד נושא או הפעילו קטעי קריאה.");
        s.order = order;
        s.cursor = 0;
        s.scores = { a: 0, b: 0 };
        s.winner = null;
        s.round = null;
        this.nextRound(now, FIRST_COUNTDOWN_MS);
        break;
      }
      case "answer": {
        if (!me.seat || s.phase !== "question" || !s.round) return refuse("no open question");
        if (!Number.isInteger(msg.choice) || msg.choice < 0 || msg.choice > 3) return refuse("bad choice");
        if (s.round.answers[me.seat]) return refuse("already answered");
        this.submit(me.seat, msg.choice, now);
        break;
      }
      case "bank": {
        if (me.seat !== "a") return refuse("only the host picks the questions");
        if (s.phase !== "lobby" && s.phase !== "over") return refuse("questions are locked during a match");
        if (!this.sets().some((x) => x.id === msg.id)) return refuse("unknown question set");
        s.source = msg.id === "builtin" ? { kind: "builtin" } : { kind: "nite", id: msg.id.slice("nite:".length) };
        this.resetBank();
        break;
      }
      case "ready": {
        const round = s.round;
        if (!me.seat || s.phase !== "reading" || !round?.ready) return refuse("nothing to read now");
        round.ready[me.seat] = true;
        if (SEATS.every((x) => round.ready?.[x])) this.endReading(now);
        break;
      }
      case "taunt": {
        if (!me.seat || !TAUNTS.includes(msg.emoji)) return refuse("bad taunt");
        if (now - me.lastTaunt < TAUNT_GAP_MS) return;
        ws.serializeAttachment({ ...me, lastTaunt: now });
        for (const peer of this.ctx.getWebSockets()) send(peer, { t: "taunt", seat: me.seat, emoji: msg.emoji });
        return;
      }
      default:
        return refuse("unknown message");
    }
    await this.commit();
  }

  async webSocketClose(ws, code) {
    // The runtime still lists a closing socket, so commit leaves it out by its ready state.
    try { ws.close(code === 1005 ? 1000 : code, "bye"); } catch {}
    await this.commit();
  }

  async webSocketError() {
    await this.commit();
  }

  async alarm() {
    const s = this.s;
    if (!s) return;
    const now = Date.now();
    if (!this.openSockets().length && s.idleSince !== null && now - s.idleSince >= IDLE_MS) {
      await this.ctx.storage.deleteAll();
      this.s = null;
      return;
    }
    if (s.phase === "reading" && s.deadline !== null && now >= s.deadline) {
      this.endReading(now);
    } else if (s.phase === "countdown" && s.deadline !== null && now >= s.deadline) {
      s.phase = "question";
      s.deadline = null;
      if (s.round) s.round.openedAt = now;
      this.planBot(now);
    } else if (s.phase === "question" && s.bot?.plan && !s.round?.answers.b && now >= s.bot.plan.at) {
      this.submit("b", s.bot.plan.choice, now);
    } else if (s.phase === "question" && s.round?.graceEndsAt != null && now >= s.round.graceEndsAt) {
      this.reveal(now);
    } else if (s.phase === "reveal" && s.deadline !== null && now >= s.deadline) {
      if (s.winner) {
        s.phase = "over";
        s.deadline = null;
      } else {
        this.nextRound(now, NEXT_COUNTDOWN_MS);
      }
    }
    await this.commit();
  }

  submit(seat, choice, now) {
    const s = /** @type {State} */ (this.s);
    const round = /** @type {Round} */ (s.round);
    round.answers[seat] = { choice, at: now };
    if (!round.first) {
      round.first = seat;
      round.graceEndsAt = now + s.settings.grace * 1000;
      // The human locked in first: a bot that was slower now answers inside the grace time.
      const plan = s.bot?.plan;
      if (plan && seat === "a") plan.at = Math.min(plan.at, now + s.settings.grace * 1000 * (0.3 + Math.random() * 0.6));
    }
    if (SEATS.every((x) => round.answers[x])) this.reveal(now);
  }

  /** The level is the chance that the bot knows the answer: the human's accuracy plus a capped lean. */
  botLevel() {
    const s = /** @type {State} */ (this.s);
    const bot = /** @type {Bot} */ (s.bot);
    const lean = clamp((s.scores.a - s.scores.b) * BOT.leanPerPoint, -BOT.maxLean, BOT.maxLean);
    return { level: clamp(bot.accuracy + lean, BOT.minLevel, BOT.maxLevel), lean };
  }

  planBot(now) {
    const s = /** @type {State} */ (this.s);
    if (!s.bot || !s.round) return;
    const { level, lean } = this.botLevel();
    const correct = this.question(s.round.q).answer;
    // A bot that does not know guesses one of the 4 choices, so it is sometimes right by luck.
    const choice = Math.random() < level ? correct : Math.floor(Math.random() * 4);
    const delay = s.bot.speedMs * (1 - 2 * lean) * (0.7 + Math.random() * 0.6);
    s.bot.plan = { at: now + clamp(delay, BOT.minDelayMs, BOT.maxDelayMs), choice };
  }

  /** After each round the bot learns how often and how fast the human answers right. */
  learnFromHuman(correct) {
    const s = /** @type {State} */ (this.s);
    const bot = s.bot;
    const round = s.round;
    if (!bot || !round) return;
    const answer = round.answers.a;
    const hit = answer?.choice === correct ? 1 : 0;
    bot.accuracy += BOT.learnRate * (hit - bot.accuracy);
    if (answer && round.openedAt !== null) bot.speedMs += BOT.learnRate * (answer.at - round.openedAt - bot.speedMs);
    bot.plan = null;
    if (Math.random() < BOT.tauntChance) {
      const d = round.result?.deltas.b ?? 0;
      this.outbox.push({ t: "taunt", seat: "b", emoji: d > 0 ? "😏" : d < 0 ? "🤡" : "🫡" });
    }
  }

  /**
   * The match order: passage questions stay together in test order after their passage,
   * every other question is its own unit, and the units are shuffled.
   */
  buildOrder() {
    const s = /** @type {State} */ (this.s);
    const sections = new Set(s.settings.sections);
    const rows = this.rows();
    if (!rows) {
      const picked = QUESTIONS.flatMap((q, i) => (sections.has(q.section) ? [i] : []));
      return shuffled(picked.length).map((j) => picked[j]);
    }
    const units = new Map();
    for (const [i, row] of rows.entries()) {
      if (!sections.has(row.section)) continue;
      if (row.contextKind === "passage" && !s.settings.passages) continue;
      const key = row.contextKind === "passage" ? `p:${row.context}` : `q:${i}`;
      if (!units.has(key)) units.set(key, []);
      units.get(key).push(i);
    }
    const list = [...units.values()];
    return shuffled(list.length).flatMap((u) => list[u]);
  }

  nextRound(now, countdownMs) {
    const s = /** @type {State} */ (this.s);
    if (s.cursor >= s.order.length) {
      s.order = this.buildOrder();
      s.cursor = 0;
    }
    const previous = s.round?.context ?? null;
    const q = s.order[s.cursor++];
    const { context, contextKind } = this.question(q);
    // A new passage starts with a reading phase. The next questions of the same passage do not.
    const read = contextKind === "passage" && context !== previous;
    s.round = {
      number: (s.round?.number ?? 0) + 1, q, openedAt: null, first: null,
      graceEndsAt: null, answers: {}, result: null, context,
      ready: read ? { a: false, b: Boolean(s.bot) } : null,
    };
    s.phase = read ? "reading" : "countdown";
    s.deadline = now + (read ? s.settings.reading * 1000 : countdownMs);
  }

  endReading(now) {
    const s = /** @type {State} */ (this.s);
    s.phase = "countdown";
    s.deadline = now + NEXT_COUNTDOWN_MS;
  }

  /**
   * Scoring: a wrong answer costs 1 point. A right answer earns 1 point,
   * but two right answers are a tie and nobody scores.
   */
  reveal(now) {
    const s = /** @type {State} */ (this.s);
    const round = /** @type {Round} */ (s.round);
    const correct = this.question(round.q).answer;
    const right = (seat) => round.answers[seat]?.choice === correct;
    const tie = right("a") && right("b");
    const deltas = { a: 0, b: 0 };
    for (const seat of SEATS) {
      if (!round.answers[seat] || tie) continue;
      deltas[seat] = right(seat) ? 1 : -1;
      s.scores[seat] += deltas[seat];
    }
    round.result = { correct, tie, deltas };
    this.learnFromHuman(correct);
    // Only one player can gain in a round, so at most one player reaches the target.
    s.winner = SEATS.find((x) => deltas[x] > 0 && s.scores[x] >= s.settings.target) ?? null;
    s.phase = "reveal";
    s.deadline = now + REVEAL_MS;
  }

  /**
   * Index i of the room's bank. An imported question is an image, its choices are the numbers 1 to 4.
   * It can point to a context: a passage or a chart that several questions share.
   */
  question(i) {
    const rows = this.rows();
    if (!rows) return { ...QUESTIONS[i], image: false, context: null, contextKind: null };
    const row = rows[i];
    if (!row) throw new Error(`question ${i} is not in the room's set`);
    return {
      id: row.id, section: row.section, kind: "imported", dir: "rtl", prompt: null, choices: IMAGE_CHOICES,
      answer: row.answer, explain: null, image: true, context: row.context, contextKind: row.contextKind,
    };
  }

  /** The rows of an imported or NITE set, in test order, or null for the built-in set. */
  rows() {
    const source = this.s?.source;
    if (!source || source.kind === "builtin") return null;
    const key = JSON.stringify(source);
    if (this.cache?.key === key) return this.cache.rows;
    /** @type {Row[]} */
    const rows = [];
    const contexts = new Map();
    if (source.kind === "import") {
      const sql = this.ctx.storage.sql;
      for (const c of sql.exec("SELECT id, kind FROM contexts")) contexts.set(c.id, { kind: c.kind, file: null });
      for (const r of sql.exec("SELECT b.id, b.section, b.answer, b.context, c.kind FROM bank b LEFT JOIN contexts c ON c.id = b.context ORDER BY b.i")) {
        rows.push({ id: r.id, section: r.section, answer: r.answer, context: r.context ?? null, contextKind: r.kind ?? null, file: null });
      }
    } else {
      const banks = source.id === "all" ? this.manifest.banks : this.manifest.banks.filter((b) => b.id === source.id);
      // Ids get the bank id in front, so the sets of all tests can play together.
      for (const bank of banks) {
        for (const c of bank.contexts) contexts.set(`${bank.id}/${c.id}`, { kind: c.kind, file: `/banks/${bank.id}/${c.file}` });
        for (const q of bank.questions) {
          const context = q.context ? `${bank.id}/${q.context}` : null;
          rows.push({
            id: `${bank.id}/${q.id}`, section: q.section, answer: q.answer, context,
            contextKind: context ? contexts.get(context)?.kind ?? null : null, file: `/banks/${bank.id}/${q.file}`,
          });
        }
      }
    }
    this.cache = { key, rows, contexts };
    return rows;
  }

  /** The question sets the host can pick: the built-in set, each NITE test, and all NITE tests together. */
  sets() {
    const banks = this.manifest.banks;
    const sets = [{ id: "builtin", title: "השאלון המובנה", count: QUESTIONS.length }];
    for (const b of banks) sets.push({ id: `nite:${b.id}`, title: b.title, count: b.questions.length });
    if (banks.length > 1) sets.push({ id: "nite:all", title: NITE_ALL, count: banks.reduce((n, b) => n + b.questions.length, 0) });
    return sets;
  }

  /** A new set: the match order starts over, and a finished match goes back to the lobby. */
  resetBank() {
    const s = /** @type {State} */ (this.s);
    this.cache = null;
    s.cursor = 0;
    s.order = [];
    s.round = null;
    if (s.phase === "over") { s.phase = "lobby"; s.winner = null; s.scores = { a: 0, b: 0 }; }
  }

  bankView() {
    const s = /** @type {State} */ (this.s);
    const rows = this.rows();
    const base = { sets: this.sets() };
    if (!rows) return { ...base, set: "builtin", title: null, count: QUESTIONS.length, counts: BUILTIN_COUNTS, passages: 0, passageQuestions: 0, charts: 0, notice: null };
    const counts = {};
    for (const r of rows) counts[r.section] = (counts[r.section] ?? 0) + 1;
    const kinds = [...(this.cache?.contexts.values() ?? [])].map((c) => c.kind);
    const source = s.source;
    const title = source.kind === "import" ? source.title
      : source.id === "all" ? NITE_ALL : this.manifest.banks.find((b) => b.id === source.id)?.title ?? source.id;
    return {
      ...base, set: source.kind === "import" ? "import" : `nite:${source.id}`, title, count: rows.length, counts,
      passages: kinds.filter((k) => k === "passage").length,
      passageQuestions: rows.filter((r) => r.contextKind === "passage").length,
      charts: kinds.filter((k) => k === "chart").length,
      notice: NITE_NOTICE,
    };
  }

  /**
   * The host uploads an imported question set, or deletes it to go back to the built-in set.
   * Body: { token, title, questions: [{ id, section, answer, mime, image: base64, context: id | null }],
   *   contexts: [{ id, kind: "passage" | "chart", mime, image: base64 }] }.
   */
  async importBank(request, remove = false) {
    const s = /** @type {State} */ (this.s);
    let body;
    try { body = await request.json(); } catch { return Response.json({ error: "bad json" }, { status: 400 }); }
    if (typeof body?.token !== "string" || s.seats.a?.token !== body.token) return Response.json({ error: "only the host imports questions" }, { status: 403 });
    if (s.phase !== "lobby" && s.phase !== "over") return Response.json({ error: "questions are locked during a match" }, { status: 409 });
    const sql = this.ctx.storage.sql;
    // An import replaces the whole set, so the tables start fresh with the current schema.
    const reset = () => {
      sql.exec("DROP TABLE IF EXISTS bank");
      sql.exec("DROP TABLE IF EXISTS contexts");
      sql.exec("CREATE TABLE contexts (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('passage', 'chart')), mime TEXT NOT NULL, image BLOB NOT NULL)");
      sql.exec("CREATE TABLE bank (i INTEGER PRIMARY KEY, id TEXT NOT NULL, section TEXT NOT NULL, answer INTEGER NOT NULL CHECK (answer BETWEEN 0 AND 3), mime TEXT NOT NULL, image BLOB NOT NULL, context TEXT REFERENCES contexts (id))");
    };
    if (remove) {
      this.ctx.storage.transactionSync(reset);
      s.source = { kind: "builtin" };
    } else {
      const list = body.questions;
      const title = typeof body.title === "string" ? body.title.trim().slice(0, 80) : "";
      if (!Array.isArray(list) || !list.length || list.length > IMPORT_MAX_QUESTIONS) return Response.json({ error: `send 1 to ${IMPORT_MAX_QUESTIONS} questions` }, { status: 400 });
      const image = (x) => {
        const bytes = typeof x?.image === "string" ? Uint8Array.fromBase64(x.image) : null;
        return bytes && bytes.length > 0 && bytes.length <= IMAGE_MAX_BYTES && IMAGE_TYPES.includes(x.mime) ? bytes : null;
      };
      const contextList = body.contexts ?? [];
      if (!Array.isArray(contextList)) return Response.json({ error: "contexts must be a list" }, { status: 400 });
      const contexts = new Map();
      for (const [i, c] of contextList.entries()) {
        const bytes = image(c);
        if (typeof c?.id !== "string" || c.id.length > 60 || !CONTEXT_KINDS.includes(c.kind) || !bytes || contexts.has(c.id)) {
          return Response.json({ error: `context ${i + 1} is not valid` }, { status: 400 });
        }
        contexts.set(c.id, [c.id, c.kind, c.mime, bytes]);
      }
      const rows = [];
      for (const [i, q] of list.entries()) {
        const bytes = image(q);
        const context = q?.context ?? null;
        const ok = typeof q?.id === "string" && q.id.length <= 40 && SECTIONS.includes(q.section) &&
          Number.isInteger(q.answer) && q.answer >= 0 && q.answer <= 3 && bytes &&
          (context === null || contexts.has(context));
        if (!ok) return Response.json({ error: `question ${i + 1} is not valid` }, { status: 400 });
        rows.push([i, q.id, q.section, q.answer, q.mime, bytes, context]);
      }
      this.ctx.storage.transactionSync(() => {
        reset();
        for (const row of contexts.values()) sql.exec("INSERT INTO contexts (id, kind, mime, image) VALUES (?, ?, ?, ?)", ...row);
        for (const row of rows) sql.exec("INSERT INTO bank (i, id, section, answer, mime, image, context) VALUES (?, ?, ?, ?, ?, ?, ?)", ...row);
      });
      s.source = { kind: "import", title: title || "שאלון מיובא" };
    }
    this.resetBank();
    await this.commit();
    return Response.json({ ok: true, count: this.rows()?.length ?? QUESTIONS.length });
  }

  /** The image of the open question only, so nobody can read a question before it opens. */
  roundImage(request) {
    const s = /** @type {State} */ (this.s);
    const round = s.round;
    const wanted = Number(new URL(request.url).searchParams.get("round"));
    const shown = s.phase === "question" || s.phase === "reveal" || s.phase === "over";
    const row = round ? this.rows()?.[round.q] : null;
    if (!row || !shown || round?.number !== wanted) return Response.json({ error: "no image for this round" }, { status: 404 });
    if (row.file) return this.asset(row.file, 600);
    const r = this.ctx.storage.sql.exec("SELECT mime, image FROM bank WHERE i = ?", round.q).one();
    return new Response(r.image, { headers: { "Content-Type": r.mime, "Cache-Control": "private, max-age=600" } });
  }

  /** A NITE image from the assets. The worker blocks /banks/ for browsers, the binding still reads it. */
  async asset(file, maxAge) {
    const res = await this.env.ASSETS.fetch(new URL(file, ASSET_ORIGIN));
    if (!res.ok) throw new Error(`asset ${file} is missing (${res.status})`);
    return new Response(res.body, { headers: { "Content-Type": res.headers.get("Content-Type") ?? "image/webp", "Cache-Control": `private, max-age=${maxAge}` } });
  }

  /**
   * The context of the open round only. A passage opens with its reading phase, a chart with its question.
   * The id in the URL lets the browser cache a passage across its questions.
   */
  contextImage(request) {
    const s = /** @type {State} */ (this.s);
    const round = s.round;
    const id = new URL(request.url).searchParams.get("id");
    const q = round ? this.question(round.q) : null;
    const open = q?.contextKind === "passage"
      ? ["reading", "countdown", "question", "reveal", "over"].includes(s.phase)
      : ["question", "reveal", "over"].includes(s.phase);
    if (!q || !id || q.context !== id || !open) return Response.json({ error: "no context for this round" }, { status: 404 });
    const file = this.cache?.contexts.get(id)?.file;
    if (file) return this.asset(file, 3600);
    const row = this.ctx.storage.sql.exec("SELECT mime, image FROM contexts WHERE id = ?", id).one();
    return new Response(row.image, { headers: { "Content-Type": row.mime, "Cache-Control": "private, max-age=3600" } });
  }

  openSockets() {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN);
  }

  /** Saves the state, sets the next alarm and sends every socket its view. */
  async commit() {
    const s = this.s;
    if (!s) return;
    const sockets = this.openSockets();
    if (sockets.length) s.idleSince = null;
    else s.idleSince ??= Date.now();
    await this.ctx.storage.put("s", s);

    const wakes = [];
    if (s.phase === "reading" || s.phase === "countdown" || s.phase === "reveal") wakes.push(s.deadline);
    if (s.phase === "question") wakes.push(s.round?.graceEndsAt);
    if (s.phase === "question" && !s.round?.answers.b) wakes.push(s.bot?.plan?.at);
    if (s.idleSince !== null) wakes.push(s.idleSince + IDLE_MS);
    const next = Math.min(...wakes.filter((x) => typeof x === "number"));
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next);
    else await this.ctx.storage.deleteAlarm();

    const online = new Set(sockets.map((ws) => ws.deserializeAttachment()?.seat).filter(Boolean));
    if (s.bot) online.add("b");
    for (const ws of sockets) send(ws, this.view(ws.deserializeAttachment()?.seat ?? null, online));
    for (const msg of this.outbox.splice(0)) for (const ws of sockets) send(ws, msg);
  }

  /** What one socket may see: no correct answer and no rival choice before the reveal. */
  view(seat, online) {
    const s = /** @type {State} */ (this.s);
    const round = s.round;
    const shown = s.phase === "question" || s.phase === "reveal" || s.phase === "over";
    const revealed = s.phase === "reveal" || s.phase === "over";
    const q = round ? this.question(round.q) : null;
    const contextOpen = q?.contextKind === "passage" ? s.phase !== "lobby" : shown;
    return {
      t: "state", now: Date.now(), you: seat, code: s.code, settings: s.settings, phase: s.phase,
      scores: s.scores, deadline: s.deadline, winner: s.winner, taunts: TAUNTS, limits: LIMITS,
      // The bot level stays on the server: players should feel a rival, not see the balancing.
      bot: Boolean(s.bot),
      bank: this.bankView(),
      players: Object.fromEntries(SEATS.map((x) => [x, s.seats[x] && { name: s.seats[x].name, online: online.has(x) }])),
      round: round && q && {
        number: round.number, openedAt: round.openedAt, first: round.first, graceEndsAt: round.graceEndsAt,
        question: shown ? { id: q.id, section: q.section, kind: q.kind, dir: q.dir, prompt: q.prompt, choices: q.choices, image: q.image } : null,
        context: q.context && contextOpen ? { id: q.context, kind: q.contextKind } : null,
        ready: round.ready,
        answered: { a: !!round.answers.a, b: !!round.answers.b },
        mine: seat ? round.answers[seat]?.choice ?? null : null,
        choices: revealed ? { a: round.answers.a?.choice ?? null, b: round.answers.b?.choice ?? null } : null,
        result: revealed ? round.result : null,
        explain: revealed ? q.explain ?? null : null,
      },
    };
  }
}

/** The NITE sets that the build step wrote (tools/build-banks.mjs). No manifest means no NITE sets. */
async function loadManifest(env) {
  const res = await env.ASSETS.fetch(new URL("/banks/manifest.json", ASSET_ORIGIN));
  if (res.status === 404) return { banks: [] };
  if (!res.ok) throw new Error(`banks manifest: HTTP ${res.status}`);
  const manifest = await res.json();
  if (!Array.isArray(manifest?.banks)) throw new Error("banks manifest has no banks list");
  for (const b of manifest.banks) {
    const ok = typeof b.id === "string" && typeof b.title === "string" && Array.isArray(b.questions) && Array.isArray(b.contexts) &&
      b.questions.every((q) => SECTIONS.includes(q.section) && Number.isInteger(q.answer) && q.answer >= 0 && q.answer <= 3 && typeof q.file === "string");
    if (!ok) throw new Error(`banks manifest: bank ${b?.id} is not valid`);
  }
  return manifest;
}

function clamp(x, min, max) {
  return Math.min(max, Math.max(min, x));
}

function send(ws, data) {
  try { ws.send(JSON.stringify(data)); } catch {}
}
