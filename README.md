# psychometric

A 1v1 quiz duel in the style of the Israeli Psychometric Entrance Test, at
<https://psychometric.yarden-zamir.com>. Two devices join one room with a 4 character code.

## Rules

- Both players get the same question. The first answer locks in.
- After the first answer, the other player has a grace time to answer (15 seconds by default).
- A right answer earns 1 point. A wrong answer costs 1 point. Two right answers are a tie, and nobody scores.
- The first player to reach the target wins (10 points by default).
- The host sets the target and the grace time in the lobby.
- "🤖 נגד בוט" starts a room against a bot. The bot copies the accuracy and speed of the player,
  then becomes a bit stronger or weaker by the score gap. That change is capped, so a stronger
  player still wins more often.

## Questions

- The built-in set (`worker/questions.json`) has 100 original questions in the formats of the test.
  They are not NITE questions.
- The host can import a NITE practice test PDF into a room (`site/import.js`). The room keeps the
  questions as images with the answer key. The page then shows the NITE copyright notice.
  The import keeps about 66 questions per test. It skips questions that share a reading passage
  or a chart. It needs a PDF with a text layer, such as the NITE `_acc` files.
- NITE practice tests: [public use](https://www.nite.org.il/practice-tests/hebrew-tests-public-use/)
  (free public tools are allowed, with the notice) and
  [personal use](https://www.nite.org.il/?page_id=2617) (personal practice only).

## Develop

```sh
npx wrangler dev --port 8795   # local server with a local Durable Object
npx wrangler deploy            # deploy to Cloudflare
npm install --prefix tools --package-lock=false && node tools/import-check.mjs   # check the importer on PDFs
```

`tools/import-check.mjs` reads sample PDFs from `/tmp/psy-src/pdf/` and writes crops to
`tools/crops/` (ignored by git, because the crops are NITE content).

Agents: read [AGENTS.md](AGENTS.md).
