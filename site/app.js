// Psychometric showdown client. The server owns the game; this page renders its state and adds the noise.
const app = document.getElementById("app");
const fx = document.getElementById("fx");
const foot = document.getElementById("foot");
const roomChip = document.getElementById("room-chip");
const muteButton = document.getElementById("mute");
const announce = document.getElementById("announce");

const CODE_PATTERN = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;
const NAME_KEY = "psy.name";
const MUTE_KEY = "psy.mute";
const TOKEN_KEY = "psy.token";
const URGENT_SECONDS = 5;
const OWN_NOTICE = "השאלות המובנות נכתבו במיוחד למשחק, בסגנון הבחינה הפסיכומטרית. הן אינן שאלות של מאל\"ו.";

/** One token per tab, so two tabs on one device can be two players, and a reload keeps the seat. */
function seatToken() {
  let token = sessionStorage.getItem(TOKEN_KEY);
  if (!token) {
    token = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    sessionStorage.setItem(TOKEN_KEY, token);
  }
  return token;
}

const esc = (text) => String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const other = (seat) => (seat === "a" ? "b" : "a");

/* ---------- Sound: everything is synthesized, so the page has no audio files. ---------- */

let audio = null;
let muted = localStorage.getItem(MUTE_KEY) === "1";
function sound() {
  audio ??= new AudioContext();
  if (audio.state === "suspended") audio.resume();
  return audio;
}
function tone({ freq, dur = 0.12, type = "square", vol = 0.12, to = null, at = 0 }) {
  if (muted) return;
  const ctx = sound();
  const t = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}
const sfx = {
  tick: (urgent, tock) => tone({ freq: (tock ? 900 : 1300) * (urgent ? 1.35 : 1), dur: 0.05, type: "square", vol: urgent ? 0.11 : 0.07 }),
  beep: () => tone({ freq: 660, dur: 0.14, type: "square", vol: 0.1 }),
  go: () => { tone({ freq: 880, dur: 0.3, type: "sawtooth", vol: 0.09 }); tone({ freq: 1320, dur: 0.3, type: "square", vol: 0.05 }); },
  lock: () => { tone({ freq: 220, to: 1400, dur: 0.28, type: "sawtooth", vol: 0.1 }); tone({ freq: 140, dur: 0.18, type: "square", vol: 0.12, at: 0.26 }); },
  mine: () => tone({ freq: 500, to: 800, dur: 0.12, type: "triangle", vol: 0.15 }),
  right: () => [523, 659, 784, 1047].forEach((f, i) => tone({ freq: f, dur: 0.16, type: "square", vol: 0.08, at: i * 0.08 })),
  wrong: () => [392, 370, 349, 294].forEach((f, i) => tone({ freq: f, to: i === 3 ? 220 : null, dur: i === 3 ? 0.7 : 0.26, type: "sawtooth", vol: 0.09, at: i * 0.28 })),
  tie: () => { tone({ freq: 300, to: 600, dur: 0.18, type: "triangle", vol: 0.15 }); tone({ freq: 600, to: 300, dur: 0.22, type: "triangle", vol: 0.15, at: 0.2 }); },
  freeze: () => tone({ freq: 1800, to: 200, dur: 0.6, type: "sine", vol: 0.12 }),
  win: () => [523, 523, 523, 698, 880, 1047].forEach((f, i) => tone({ freq: f, dur: i < 3 ? 0.12 : 0.3, type: "square", vol: 0.08, at: [0, 0.14, 0.28, 0.44, 0.62, 0.8][i] })),
  lose: () => [330, 311, 294, 262].forEach((f, i) => tone({ freq: f, dur: 0.45, type: "triangle", vol: 0.14, at: i * 0.42 })),
  pop: () => tone({ freq: 900, to: 1500, dur: 0.08, type: "sine", vol: 0.12 }),
};
function setMuted(value) {
  muted = value;
  localStorage.setItem(MUTE_KEY, value ? "1" : "0");
  muteButton.textContent = value ? "🔇" : "🔊";
  muteButton.setAttribute("aria-pressed", String(value));
}
muteButton.addEventListener("click", () => { setMuted(!muted); if (!muted) sfx.pop(); });
setMuted(muted);

/* ---------- Effects ---------- */

function flash(color) {
  const el = document.createElement("div");
  el.className = "flash";
  el.style.background = color;
  fx.append(el);
  el.addEventListener("animationend", () => el.remove());
}
/** The banner stays long enough to read: about 55 ms per character, from 2.2 s to 4 s. */
function banner(html, kind = "") {
  for (const old of fx.querySelectorAll(".banner")) old.remove();
  const el = document.createElement("div");
  el.className = `banner ${kind}`;
  el.innerHTML = html;
  const ms = Math.min(4000, Math.max(2200, 1400 + 55 * el.textContent.length));
  el.style.animationDuration = `${ms}ms`;
  fx.append(el);
  el.addEventListener("animationend", () => el.remove());
  announce.textContent = el.textContent;
}
/**
 * The banner is the effect. The same text stays in the question card for the rest of the phase,
 * so a player who missed the banner can still read it.
 * @type {{ round: number, phase: string, html: string, kind: string } | null}
 */
let verdict = null;
function say(html, kind, next) {
  banner(html, kind);
  verdict = { round: next.round.number, phase: next.phase, html, kind };
}

function shake() {
  document.body.classList.remove("shake");
  void document.body.offsetWidth;
  document.body.classList.add("shake");
  setTimeout(() => document.body.classList.remove("shake"), 500);
}
function burst(emojis, count = 26) {
  for (let i = 0; i < count; i++) {
    const el = document.createElement("span");
    el.className = "fly";
    el.textContent = pick(emojis);
    el.style.left = "50%";
    el.style.top = "45%";
    const angle = Math.random() * Math.PI * 2;
    const dist = 30 + Math.random() * 45;
    el.style.setProperty("--dx", `${Math.cos(angle) * dist}vw`);
    el.style.setProperty("--dy", `${Math.sin(angle) * dist}vh`);
    el.style.setProperty("--rot", `${(Math.random() - 0.5) * 720}deg`);
    el.style.setProperty("--dur", `${1000 + Math.random() * 900}ms`);
    fx.append(el);
    el.addEventListener("animationend", () => el.remove());
  }
}
function floatEmoji(emoji, fromSeat) {
  const el = document.createElement("span");
  el.className = "float";
  el.textContent = emoji;
  // Seat a sits on the right in this right-to-left page.
  el.style.left = `${(fromSeat === "a" ? 62 : 8) + Math.random() * 30}%`;
  fx.append(el);
  el.addEventListener("animationend", () => el.remove());
}
function standoff(names, ms) {
  const el = document.createElement("div");
  el.className = "standoff";
  el.style.animationDuration = `${ms}ms`;
  el.innerHTML = `<div class="side a">${esc(names.a)}</div><div class="bolt">⚡</div><div class="side b">${esc(names.b)}</div>`;
  fx.append(el);
  el.addEventListener("animationend", (e) => { if (e.target === el) el.remove(); });
}
function countNumber(text) {
  const el = document.createElement("div");
  el.className = "count";
  el.textContent = text;
  fx.append(el);
  el.addEventListener("animationend", () => el.remove());
}

const LINES = {
  locked: ["תשובה ננעלה! 🔒", "מישהו פה בטוח בעצמו 😏", "השעון מתקתק ⏱️", "לחץ? איזה לחץ? 😅"],
  mineFirst: ["נעלת ראשון! 🔒", "מהירות האור ⚡", "עכשיו רק לחכות… 😬"],
  right: ["בּוּם! 💥", "גאון/ית! 🧠", "נקודה! ✨", "מאל\"ו גאים בך 🎓"],
  wrong: ["אאוץ' 💀", "לא היום 🫠", "הבוחן בוכה 😭", "אופס… 🤡"],
  tie: ["תיקו! 🤝", "מוחות גדולים חושבים דומה 🧠🧠", "אף אחד לא זז 😐"],
  freeze: ["קפאת מול השעון 🧊", "הזמן נגמר ⌛"],
  rivalRight: ["היריב/ה קטף/ה נקודה 😤", "אוי, הם צדקו 😩"],
  rivalWrong: ["היריב/ה נפל/ה בפח 😂", "נקודה פחות ליריב/ה 🎯"],
};

/* ---------- Connection ---------- */

/** @type {any} */
let state = null;
let clockOffset = 0;
let socket = null;
let everOpened = false;
let retry = 0;
let code = null;
let fatal = null;
let importStatus = "";
// Imported questions are wide page crops. A tap zooms them, and the zoom holds across renders.
let zoomed = false;
const serverNow = () => Date.now() + clockOffset;

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${proto}://${location.host}/api/rooms/${code}/ws`);
  socket.addEventListener("open", () => {
    everOpened = true;
    retry = 0;
    socket.send(JSON.stringify({ t: "hello", token: seatToken(), name: localStorage.getItem(NAME_KEY) ?? "" }));
  });
  socket.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.t === "state") onState(msg);
    else if (msg.t === "taunt") { floatEmoji(msg.emoji, msg.seat); sfx.pop(); }
    else if (msg.t === "error") toast(msg.error);
  });
  socket.addEventListener("close", (event) => {
    if (event.code === 4404 || !everOpened) {
      fatal = "החדר לא נמצא. בדקו את הקוד או צרו חדר חדש.";
      render();
      return;
    }
    roomChip.innerHTML = `<span class="sticker bad">מתחבר מחדש…</span>`;
    setTimeout(connect, Math.min(8000, 500 * 2 ** retry++));
  });
}
function sendMsg(data) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
}
function toast(text) {
  banner(esc(text), "bad");
}

/* ---------- State changes fire the effects ---------- */

function onState(next) {
  clockOffset = next.now - Date.now();
  const prev = state;
  state = next;
  effects(prev, next);
  render();
}

function effects(prev, next) {
  const me = next.you;
  const names = { a: next.players.a?.name ?? "?", b: next.players.b?.name ?? "?" };
  const roundChanged = prev?.round?.number !== next.round?.number;
  if (next.phase === "countdown" && (prev?.phase !== "countdown" || roundChanged)) {
    const ms = Math.max(0, next.deadline - serverNow());
    standoff(names, ms);
    if (next.round.number === 1) {
      [3, 2, 1].forEach((n, i) => setTimeout(() => { countNumber(n); sfx.beep(); }, i * (ms / 3)));
    } else {
      sfx.beep();
    }
  }
  if (next.phase === "question" && prev?.phase === "countdown") {
    sfx.go();
    flash("var(--select)");
  }
  const first = next.round?.first;
  if (next.phase === "question" && first && prev?.round?.first !== first && !roundChanged) {
    if (first === me) {
      sfx.mine();
      say(`${pick(LINES.mineFirst)}<small>${esc(names[other(first)])} עוד חושבים</small>`, "info", next);
    } else {
      sfx.lock();
      flash("var(--error)");
      shake();
      say(`${pick(LINES.locked)}<small>${esc(names[first])} ענו. יש לך ${next.settings.grace} שניות</small>`, "bad", next);
      if (navigator.vibrate) navigator.vibrate([80, 40, 80]);
    }
  }
  if (next.phase === "reveal" && prev?.phase !== "reveal") revealEffects(next, me);
  if (next.phase === "over" && prev?.phase !== "over") {
    if (me && next.winner === me) {
      sfx.win();
      burst(["🏆", "🎉", "👑", "🧠", "✨"], 60);
      banner("ניצחון! 🏆", "good");
    } else if (me) {
      sfx.lose();
      burst(["💀", "🫠", "🐢"], 20);
      banner(`${esc(names[next.winner])} ניצחו 😵`, "bad");
    } else {
      sfx.win();
      banner(`${esc(names[next.winner])} ניצחו! 🏆`, "good");
    }
  }
}

function revealEffects(next, me) {
  const result = next.round.result;
  if (!result) return;
  if (!me) {
    if (result.tie) sfx.tie(); else sfx.pop();
    return;
  }
  const mine = result.deltas[me];
  const theirs = result.deltas[other(me)];
  const answered = next.round.choices[me] !== null;
  if (result.tie) {
    sfx.tie();
    burst(["🤝", "🧠"], 14);
    say(`${pick(LINES.tie)}<small>שניכם צדקתם, אין נקודות</small>`, "info", next);
  } else if (mine > 0) {
    sfx.right();
    flash("var(--green)");
    burst(["✨", "🧠", "💥", "⭐"], 26);
    say(`${pick(LINES.right)}<small><span class="ltr">+1</span>${theirs < 0 ? ` · והיריב/ה <span class="ltr">−1</span> 😈` : ""}</small>`, "good", next);
  } else if (mine < 0) {
    sfx.wrong();
    flash("var(--error)");
    shake();
    say(`${pick(LINES.wrong)}<small><span class="ltr">−1</span>${theirs > 0 ? ` · והיריב/ה <span class="ltr">+1</span>` : ""}</small>`, "bad", next);
  } else if (!answered) {
    sfx.freeze();
    burst(["🧊", "⌛"], 12);
    say(`${pick(LINES.freeze)}<small>${theirs > 0 ? pick(LINES.rivalRight) : theirs < 0 ? pick(LINES.rivalWrong) : ""}</small>`, theirs > 0 ? "bad" : "info", next);
  }
}

/* ---------- Grace timer: drains the bar and ticks faster near the end ---------- */

let lastTick = null;
function frame() {
  requestAnimationFrame(frame);
  const box = document.querySelector(".grace");
  const round = state?.round;
  if (!box || state?.phase !== "question" || !round?.graceEndsAt) {
    document.body.classList.remove("panic");
    lastTick = null;
    return;
  }
  const total = state.settings.grace * 1000;
  const left = Math.max(0, round.graceEndsAt - serverNow());
  const urgent = left <= URGENT_SECONDS * 1000;
  box.classList.toggle("urgent", urgent);
  box.querySelector(".fill").style.transform = `scaleX(${left / total})`;
  box.querySelector(".secs").textContent = (left / 1000).toFixed(urgent ? 1 : 0);
  // The player who still has to answer gets the panic glow.
  const waiting = state.you && !round.answered[state.you];
  document.body.classList.toggle("panic", Boolean(urgent && waiting && left > 0));
  const step = urgent ? 250 : 500;
  const slot = Math.floor(left / step);
  if (lastTick !== slot && left > 0) {
    if (lastTick !== null) sfx.tick(urgent, slot % 2 === 0);
    lastTick = slot;
  }
}
requestAnimationFrame(frame);

/* ---------- Rendering ---------- */

const SECTION_NAMES = { verbal: "חשיבה מילולית", quantitative: "חשיבה כמותית", english: "אנגלית" };

function render() {
  if (fatal) {
    roomChip.innerHTML = "";
    app.innerHTML = `<section class="card pad stack center"><h2>😵 ${esc(fatal)}</h2><a class="btn primary" href="/">למסך הבית</a></section>`;
    return;
  }
  if (!code) return renderHome();
  if (!state) {
    app.innerHTML = `<section class="card pad center"><span class="sticker wait">מתחבר לחדר ${esc(code)}…</span></section>`;
    return;
  }
  roomChip.innerHTML = `<span class="sticker info mono">${esc(state.code)}</span>`;
  foot.textContent = state.bank.notice ?? OWN_NOTICE;
  const parts = [scoreboard()];
  if (state.phase === "lobby") parts.push(lobby());
  else if (state.phase === "countdown") parts.push(`<section class="card pad center"><h2>מתכוננים… ⚡</h2><p class="muted">סיבוב ${state.round.number}</p></section>`);
  else parts.push(questionCard());
  if (state.phase === "over") parts.push(overCard());
  if (state.you && state.phase !== "lobby") parts.push(tauntBar());
  app.innerHTML = parts.join("");
  bind();
}

function playerCard(seat) {
  const p = state.players[seat];
  if (!p) return `<div class="card player ${seat} empty"><span class="name">מחכים ליריב/ה…</span><span class="muted">שלחו את הקוד</span></div>`;
  const target = state.settings.target;
  const score = state.scores[seat];
  const pips = target <= 20
    ? `<div class="pips">${Array.from({ length: target }, (_, i) => `<i class="${i < score ? "on" : ""}"></i>`).join("")}</div>`
    : `<span class="muted mono">מתוך ${target}</span>`;
  const round = state.round;
  let status = "";
  if (state.phase === "question" && round) {
    if (round.answered[seat]) status = round.first === seat ? `<span class="sticker wait">🔒 ראשון/ה</span>` : `<span class="sticker ok">✓ ענו</span>`;
    else status = `<span class="sticker">חושבים…</span>`;
  } else if (state.phase === "reveal" && round?.result) {
    const d = round.result.deltas[seat];
    status = round.result.tie ? `<span class="sticker info">תיקו</span>` : d > 0 ? `<span class="sticker ok ltr">+1</span>` : d < 0 ? `<span class="sticker bad ltr">−1</span>` : `<span class="sticker">0</span>`;
  }
  const you = state.you === seat ? `<span class="sticker wait tag">אני</span>`
    : seat === "b" && state.bot ? `<span class="sticker info tag">רמה ${state.bot.level}%</span>` : "";
  return `<div class="card player ${seat} ${p.online ? "" : "offline"}">${you}
    <span class="name">${esc(p.name)}</span>
    <span class="score">${score}</span>${pips}<div class="answered">${status}</div></div>`;
}

function scoreboard() {
  return `<section class="versus">${playerCard("a")}<span class="vs">VS</span>${playerCard("b")}</section>`;
}

function lobby() {
  const host = state.you === "a";
  const ready = state.players.a && state.players.b;
  const link = `${location.origin}/?code=${state.code}`;
  const { target, grace } = state.settings;
  const L = state.limits;
  const bank = state.bank.title
    ? `<b>${esc(state.bank.title)}</b> · ${state.bank.count} שאלות (${Object.entries(state.bank.counts).map(([k, n]) => `${SECTION_NAMES[k] ?? k} ${n}`).join(", ")})`
    : `<b>השאלון המובנה</b> · ${state.bank.count} שאלות`;
  return `
  <section class="card pad stack center">
    <span class="label">${state.bot ? "קוד החדר (אפשר לצפות)" : "קוד החדר"}</span>
    <span class="code-big">${esc(state.code)}</span>
    <div class="row"><button class="btn" data-act="share" data-link="${esc(link)}">🔗 שיתוף קישור</button>
      ${state.you ? "" : `<span class="sticker">צופים</span>`}</div>
    ${state.you ? `<button class="btn go" data-act="start" ${ready ? "" : "disabled"}>${ready ? "⚔️ לקרב!" : "מחכים לשחקן/ית שני/ה…"}</button>` : ""}
  </section>
  <section class="card pad stack">
    <span class="label">הגדרות ${host ? "" : "(המארח/ת קובע/ת)"}</span>
    <div class="settings">
      <label>נקודות לניצחון <input class="field mono" type="number" data-setting="target" min="${L.target[0]}" max="${L.target[1]}" value="${target}" ${host ? "" : "disabled"}></label>
      <label>שניות לשני/ה אחרי תשובה ראשונה <input class="field mono" type="number" data-setting="grace" min="${L.grace[0]}" max="${L.grace[1]}" value="${grace}" ${host ? "" : "disabled"}></label>
    </div>
    <span class="label">שאלון</span>
    <div>${bank}</div>
    ${host ? `<div class="row">
      <label class="btn">📄 ייבוא שאלון מ־PDF<input type="file" accept="application/pdf" data-act="import" hidden></label>
      ${state.bank.title ? `<button class="btn small" data-act="builtin">חזרה לשאלון המובנה</button>` : ""}
      <span id="import-status" class="muted">${esc(importStatus)}</span></div>
      <p class="muted">ייבוא של בחינה לדוגמה של מאל"ו: <a href="https://www.nite.org.il/practice-tests/hebrew-tests-public-use/" target="_blank" rel="noopener">לשימוש ציבורי</a> או <a href="https://www.nite.org.il/?page_id=2617" target="_blank" rel="noopener">לתרגול אישי</a>.</p>` : ""}
  </section>
  <section class="card pad stack">
    <span class="label">חוקים</span>
    <ul class="rules">
      <li>שאלה אחת לשניכם. מי שעונה ראשון/ה נועל/ת תשובה.</li>
      <li>אחרי התשובה הראשונה, ליריב/ה יש ${grace} שניות לענות.</li>
      <li>תשובה נכונה: +1. תשובה שגויה: −1. שתי תשובות נכונות: תיקו, אין נקודות.</li>
      <li>מי שמגיע/ה ראשון/ה ל־${target} נקודות מנצח/ת.</li>
      ${state.bot ? `<li>הבוט מעתיק את הדיוק והמהירות שלך. כשמישהו מוביל, הבוט מתחזק או נחלש קצת.</li>` : ""}
    </ul>
  </section>`;
}

function questionCard() {
  const round = state.round;
  const q = round?.question;
  if (!q) return "";
  const result = round.result;
  const revealed = Boolean(result);
  const canAnswer = state.you && state.phase === "question" && round.mine === null;
  const names = { a: state.players.a?.name ?? "?", b: state.players.b?.name ?? "?" };
  const choices = q.choices.map((text, i) => {
    const cls = ["btn", "choice"];
    if (round.mine === i && !revealed) cls.push("mine");
    if (revealed && i === result.correct) cls.push("correct");
    if (revealed && i !== result.correct && Object.values(round.choices).includes(i)) cls.push("wrong");
    const who = revealed
      ? ["a", "b"].filter((s) => round.choices[s] === i).map((s) => `<span class="sticker ${s === "a" ? "info" : ""}">${esc(names[s])}</span>`).join("")
      : "";
    const label = q.image ? esc(text) : `<span class="num">(${i + 1})</span>${esc(text)}`;
    return `<button class="${cls.join(" ")}" data-choice="${i}" ${canAnswer ? "" : "disabled"}>${label}${who ? `<span class="who">${who}</span>` : ""}</button>`;
  }).join("");
  const body = q.image
    ? `<div class="qimage-wrap ${zoomed ? "zoomed" : ""}"><img class="qimage" src="/api/rooms/${esc(state.code)}/image?round=${round.number}" alt="שאלה ${round.number}"></div>
       <span class="muted zoom-hint">👆 הקשה על השאלה מגדילה אותה</span>`
    : `<div class="prompt" dir="${esc(q.dir)}">${esc(q.prompt)}</div>`;
  const grace = state.phase === "question" && round.graceEndsAt
    ? `<div class="grace"><div class="secs">${state.settings.grace}</div><div class="bar"><div class="fill"></div></div></div>`
    : "";
  const explain = revealed && round.explain ? `<div class="explain">💡 ${esc(round.explain)}</div>` : "";
  const line = verdict && verdict.round === round.number && verdict.phase === (revealed ? "reveal" : "question")
    ? `<div class="verdict ${verdict.kind}">${verdict.html}</div>` : "";
  return `<section class="card qcard">
    <div class="qhead"><span class="label">סיבוב ${round.number} · ${esc(SECTION_NAMES[q.section] ?? q.section)}</span>
      ${revealed ? `<span class="sticker ok">התשובה: (${result.correct + 1})</span>` : ""}</div>
    ${line}${body}${grace}
    <div class="choices ${q.image ? "numbers" : ""}" dir="${esc(q.dir)}">${choices}</div>
    ${explain}
  </section>`;
}

function overCard() {
  const name = state.players[state.winner]?.name ?? "?";
  return `<section class="card pad stack center">
    <h2>🏆 ${esc(name)} ${state.winner === state.you ? "(את/ה!)" : ""}</h2>
    <p class="mono">${esc(state.players.a?.name)} <span class="ltr">${state.scores.a}</span> · ${esc(state.players.b?.name)} <span class="ltr">${state.scores.b}</span></p>
    ${state.you ? `<div class="row"><button class="btn go" data-act="rematch">🔁 עוד סיבוב</button>${state.you === "a" ? `<span class="muted">אפשר לשנות הגדרות רק לפני קרב חדש</span>` : ""}</div>` : ""}
  </section>`;
}

function tauntBar() {
  return `<section class="taunts">${state.taunts.map((e) => `<button class="btn" data-taunt="${e}">${e}</button>`).join("")}</section>`;
}

function renderHome() {
  roomChip.innerHTML = "";
  foot.textContent = OWN_NOTICE;
  const name = localStorage.getItem(NAME_KEY) ?? "";
  app.innerHTML = `
  <section class="card hero stack center">
    <div class="vs-mini">🧠⚡🧠</div>
    <h2>דו־קרב פסיכומטרי</h2>
    <p class="muted">שאלה אחת, שני מוחות, שעון אחד שמתקתק. מי שעונה ראשון/ה ובצדק לוקח/ת את הנקודה.</p>
  </section>
  <section class="card pad stack">
    <label class="stack"><span class="label">השם שלך</span><input class="field" id="name" maxlength="20" value="${esc(name)}" placeholder="למשל: נועה"></label>
    <div class="row"><button class="btn go" data-act="create" data-mode="duel">⚔️ חדר חדש</button>
      <button class="btn primary" data-act="create" data-mode="bot">🤖 נגד בוט</button></div>
    <p class="muted">הבוט לומד את הקצב והדיוק שלך ומתאים את עצמו, אבל רק עד גבול מסוים.</p>
    <div class="row"><span class="label">או הצטרפות עם קוד</span>
      <input class="field code" id="join-code" maxlength="4" autocomplete="off" placeholder="AB3K" dir="ltr">
      <button class="btn primary" data-act="join">הצטרפות</button></div>
  </section>`;
  const nameInput = document.getElementById("name");
  nameInput.addEventListener("input", () => localStorage.setItem(NAME_KEY, nameInput.value.trim()));
  for (const button of app.querySelectorAll('[data-act="create"]')) {
    button.addEventListener("click", async () => {
      sound();
      button.disabled = true;
      const res = await fetch("/api/rooms", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: button.dataset.mode }),
      });
      const data = await res.json();
      if (!res.ok) { toast(data.error ?? "יצירת החדר נכשלה"); button.disabled = false; return; }
      openRoom(data.code);
    });
  }
  const join = () => {
    sound();
    const value = document.getElementById("join-code").value.trim().toUpperCase();
    if (!CODE_PATTERN.test(value)) return toast("קוד של 4 תווים, למשל AB3K");
    openRoom(value);
  };
  app.querySelector('[data-act="join"]').addEventListener("click", join);
  document.getElementById("join-code").addEventListener("keydown", (e) => { if (e.key === "Enter") join(); });
}

function bind() {
  for (const el of app.querySelectorAll("[data-choice]")) {
    el.addEventListener("click", () => {
      sound();
      sendMsg({ t: "answer", choice: Number(el.dataset.choice) });
      for (const b of app.querySelectorAll("[data-choice]")) b.disabled = true;
      el.classList.add("mine");
    });
  }
  for (const el of app.querySelectorAll("[data-setting]")) {
    el.addEventListener("change", () => {
      const value = Number(el.value);
      const [min, max] = state.limits[el.dataset.setting];
      if (!Number.isInteger(value) || value < min || value > max) { toast(`ערך בין ${min} ל־${max}`); render(); return; }
      sendMsg({ t: "settings", [el.dataset.setting]: value });
    });
  }
  for (const el of app.querySelectorAll("[data-taunt]")) {
    el.addEventListener("click", () => { sound(); sendMsg({ t: "taunt", emoji: el.dataset.taunt }); el.classList.remove("pop"); void el.offsetWidth; el.classList.add("pop"); });
  }
  app.querySelector(".qimage-wrap")?.addEventListener("click", (e) => {
    zoomed = !zoomed;
    e.currentTarget.classList.toggle("zoomed", zoomed);
  });
  app.querySelector('[data-act="start"]')?.addEventListener("click", () => { sound(); sendMsg({ t: "start" }); });
  app.querySelector('[data-act="rematch"]')?.addEventListener("click", () => { sound(); sendMsg({ t: "rematch" }); });
  app.querySelector('[data-act="share"]')?.addEventListener("click", async (e) => {
    const link = e.currentTarget.dataset.link;
    if (navigator.share) {
      try { await navigator.share({ title: "דו־קרב פסיכומטרי", text: `קוד: ${state.code}`, url: link }); } catch {}
    } else {
      await navigator.clipboard.writeText(link);
      banner("הקישור הועתק 📋", "info");
    }
  });
  app.querySelector('[data-act="import"]')?.addEventListener("change", (e) => importFile(e.currentTarget.files?.[0]));
  app.querySelector('[data-act="builtin"]')?.addEventListener("click", () => uploadBank("DELETE", {}).catch((error) => toast(error.message)));
}

/* ---------- Import a question set from a NITE PDF ---------- */

async function importFile(file) {
  if (!file) return;
  // A new state renders the lobby again, so the status lives outside the element.
  const say = (text) => {
    importStatus = text;
    const el = document.getElementById("import-status");
    if (el) el.textContent = text;
  };
  try {
    say("קורא את הקובץ…");
    const { importPdf } = await import("/import.js");
    const { title, questions } = await importPdf(await file.arrayBuffer(), (text) => say(String(text)));
    if (!questions.length) throw new Error("לא נמצאו שאלות בקובץ");
    say(`מעלה ${questions.length} שאלות…`);
    const payload = await Promise.all(questions.map(async (q) => ({
      id: q.id, section: q.section, answer: q.answer, mime: q.image.type,
      image: new Uint8Array(await q.image.arrayBuffer()).toBase64(),
    })));
    await uploadBank("POST", { title: title || file.name.replace(/\.pdf$/i, ""), questions: payload });
    say("");
    banner(`יובאו ${questions.length} שאלות 📄`, "good");
  } catch (error) {
    say("");
    toast(error instanceof Error ? error.message : String(error));
  }
}

async function uploadBank(method, body) {
  const res = await fetch(`/api/rooms/${state.code}/bank`, {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: seatToken(), ...body }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "ההעלאה נכשלה");
}

/* ---------- Start ---------- */

function openRoom(value) {
  history.replaceState(null, "", `/?code=${value}`);
  code = value;
  render();
  connect();
}

const fromUrl = new URLSearchParams(location.search).get("code")?.toUpperCase() ?? null;
if (fromUrl && CODE_PATTERN.test(fromUrl)) openRoom(fromUrl);
else render();
