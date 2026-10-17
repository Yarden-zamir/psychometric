# Psychometric duel

A 1v1 quiz race for two devices. Site: <https://psychometric.yarden-zamir.com>.

- Worker: `worker/index.js`. It creates rooms (`POST /api/rooms`) and passes `/api/rooms/<code>/ws`,
  `/bank` and `/image` to the room.
- Room: one Durable Object (`Room`, SQLite storage) per code. It owns the game state, the timers
  (one alarm) and the WebSockets (hibernation API). The server decides who answered first.
- Page: static files in `site/`, plain JavaScript, no build step. `app.js` renders the state that the
  room sends and adds the sounds (Web Audio, no files) and the effects.
- Style: tick3d neo-brutalism tokens, light and dark mode. The game uses motion and flashes on
  purpose. This is an exception to the "no continuous animation" rule of the style.
- Deploy: `npx wrangler deploy` in this folder.

## Game contract

1. A room has two seats, `a` (host) and `b`. Other sockets watch. A seat belongs to a token that the
   tab keeps in `sessionStorage`, so a reload keeps the seat.
2. Only the host changes the settings and imports questions, and only in the lobby or after a match.
3. The first answer sets `graceEndsAt` = answer time + grace. The round ends when both answered or at `graceEndsAt`.
4. Scoring: a wrong answer is −1. A right answer is +1, but two right answers are a tie with no points.
5. The player who reaches the target first wins. Only one player can gain in a round.
6. A socket never sees the correct answer or the choice of the other player before the reveal.
   An imported question image is served only for the open round.
7. A room with no sockets for 6 hours deletes its storage.
8. A bot room (`POST /api/rooms` with `{"mode": "bot"}`) puts the bot in seat `b`. Its token is
   `bot`, which fails the token check, so no person can take the seat.
9. Bot level = the accuracy of the human (moving average) + a lean of 0.04 per point of score gap,
   capped at ±0.15, then clamped to 0.2–0.92. The level is the chance that the bot knows the
   answer. If it does not know, it guesses. Its answer time follows the human's speed. If the human
   answers first, the bot answers inside the grace time. The constants are in `BOT` in `worker/index.js`.
10. An imported question can point to a context: a `passage` or a `chart` that several questions share.
    The match order keeps the questions of a passage together, in test order. Every other question
    is its own unit, and the units are shuffled.
11. The first question of a passage starts with a `reading` phase (`settings.reading` seconds,
    default 120). It ends at the deadline, or when both seats send `ready`. A bot is ready at once.
    `settings.passages: false` leaves passage questions out of the order.
12. `/api/rooms/<code>/context?id=<id>` serves only the context of the open round: a passage from its
    reading phase on, a chart from its question on.

## Questions

- `worker/questions.json`: original questions. Fields: `id`, `section` (`verbal`, `quantitative`,
  `english`), `kind`, `dir` (`rtl`, `ltr`), `prompt`, `choices` (4), `answer` (0 to 3), `explain`.
  The worker checks the file when it loads.
- Do not copy NITE test text into this repository. NITE licenses the recent tests for personal use
  only. An imported set stays in its room, and the page shows the NITE notice for it.
- `site/import.js` splits a NITE PDF into question images and reads the answer key. It also cuts
  the shared passages and charts as context images, and stacks a question that crosses a page.
  `tools/import-check.mjs` checks it against sample PDFs.
