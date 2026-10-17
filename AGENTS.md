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
13. `settings.sections` lists the subjects that play (`verbal`, `quantitative`, `english`), at least
    one. The order leaves out the questions of the other subjects, in the built-in and imported sets.
12. `/api/rooms/<code>/context?id=<id>` serves only the context of the open round: a passage from its
    reading phase on, a chart from its question on.
14. The host picks the set with `{ t: "bank", id }`: `builtin`, `nite:<bank id>` or `nite:all`, in the
    lobby or after a match. In `nite:all`, question and context ids start with `<bank id>/`.

## Questions

- `worker/questions.json`: original questions. Fields: `id`, `section` (`verbal`, `quantitative`,
  `english`), `kind`, `dir` (`rtl`, `ltr`), `prompt`, `choices` (4), `answer` (0 to 3), `explain`.
  The worker checks the file when it loads.
- NITE sets: `node tools/build-banks.mjs` turns the PDFs in `../_shared/nite-public/` into
  `site/banks/<bank id>/*.webp` and `site/banks/manifest.json`. Run it before a deploy. `site/banks/`
  is ignored by git. The worker answers 404 to `/banks/*`; a room reads the files through the
  `ASSETS` binding and serves one open round at a time. A new room plays all NITE sets.
- Only the tests from the NITE public-use page (form at
  https://www.nite.org.il/practice-tests/hebrew-tests-public-use/) go into `_shared/nite-public/`.
  NITE licenses the other tests for personal use only: a player can import one into a room, and it
  stays in that room. The page shows the NITE notice for every NITE or imported set.
- Do not copy NITE test content into git.
- `site/import.js` splits a NITE PDF into question images and reads the answer key. It also cuts
  the shared passages and charts as context images, and stacks a question that crosses a page.
  `tools/import-check.mjs` checks it against sample PDFs.
