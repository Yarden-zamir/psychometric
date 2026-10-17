# Built-in bank text

`build-banks.mjs` keeps every image fallback and adds nullable text to every
question/context. `build-banks-text.mjs` reads the original pdf.js spans; the
importer's normalized strings are used only for finding the crop regions.

```sh
node tools/build-banks.mjs
node --test tools/build-banks-text.test.mjs
node tools/validate-bank-text.mjs
uv run --script tools/build-text-sheets.py
```

The contact-sheet renderer uses a **separate, headless Chrome process**, not a
personal browser profile. It requires the macOS Chrome installation at the path
in the script. It renders real browser text beside every non-null source crop,
with at most ten items and approximately 3,000 pixels of content per sheet.
Read every PNG listed in `tools/text-review-sheets/index.local.json`, not stale
PNGs left over from an earlier run. After personally comparing every sheet:

```sh
node tools/check-text-review.mjs --record-all-checked
node tools/check-text-review.mjs
```

`text-review.json` records ids, fallback reasons, manifest and sheet hashes, and
exhaustive checked-sheet coverage. Rebuilding with different text invalidates the
review; the recording command is a human/agent attestation, **not** an automated
visual comparison. Generated text, HTML, diagnostic JSON and PNGs are ignored by
`tools/.gitignore`; never commit NITE content.

## Conservative extraction

- Quantitative questions and charts always have `text: null`.
- Every source span must fit its crop and be placeable on an ordinary baseline;
  rotated, clipped, very small/large, and malformed/control-character text fails
  closed. In particular, broken niqqud is not silently repaired or stripped.
- Question numbers and the four choice markers are explicitly consumed, exactly
  once and in order. Wrapped lines join, larger baseline gaps become paragraphs.
- Span strings are logical Unicode. Geometry orders Hebrew spans right-to-left,
  while embedded multi-span Latin runs retain their own left-to-right order.
  Neutral-only LTR glyph fragments follow the enclosing Hebrew reading order.
  No letter, vowel point or punctuation character is substituted/normalized.
- The operator-list walker applies nested graphics/form transforms. Any
  overlapping image or vector paint forces fallback, except a thin horizontal
  line occupying an empty gap beside text on a baseline. That gap becomes six
  underscores, including leading/trailing and multiple blanks. Underlines are
  **not** treated as blanks.
- Repeated choices that differ only in bold/formatting use the image: the plain
  string schema cannot preserve the question's meaning.
- Passage slices remain in importer reading order; shared English instructions
  can be prepended from an earlier page. Passage line breaks are not reflowed in
  the data. Margin numbers are recognized by geometry and moved to `n`; larger
  vertical gaps add an empty line entry.

The autumn/winter 2020 source PDFs contain a large watermark **image** overlapping
most questions/passages. The strict no-image rule deliberately keeps those crops
image-only. Exempting watermarks would be a product/safety-rule change, not a
Unicode-extraction fix.

The only importer change for this work is a non-quantitative crop-margin fix:
exclude the repeated outer-page vector ornaments. Quantitative bounds stay wide
so the text bounds cannot clip figures.
