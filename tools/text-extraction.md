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
Read every new/changed PNG listed in `tools/text-review-sheets/index.local.json`,
not stale PNGs left over from an earlier run. Byte-identical sheet hashes with
the same bank and ids may carry forward a previous personal comparison;
`reviewedInManifest` records that provenance. After comparing those sheets:

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
  overlapping image or vector paint forces fallback, except the exact NITE
  watermark identified below, and a thin horizontal
  line occupying an empty gap beside text on a baseline. That gap becomes six
  underscores, including leading/trailing and multiple blanks. Underlines are
  **not** treated as blanks.
- Repeated choices that differ only in bold/formatting use the image: the plain
  string schema cannot preserve the question's meaning.
- Passage slices remain in importer reading order; shared English instructions
  can be prepended from an earlier page. Passage line breaks are not reflowed in
  the data. Margin numbers are recognized by geometry and moved to `n`; larger
  vertical gaps add an empty line entry.

## Watermark identification (round 2)

The autumn/winter 2020 source PDFs each draw the same visually checked, very light
NITE checkmark image on **61 distinct pages** (3–60 and 62–64). Resource names and
PDF refs differ on each page; they are not an identity test. The exemption requires:

- Decoded RGB SHA-256 `3053ec4f4976a43ec74ae945b60e1042a9188494eae8aacd9fa0c43f0c8de3b2`.
- Exactly 1090 × 1650 RGB pixels (pdf.js image kind 2). The identified image's
  minimum channel is 228/255 and its mean is 250.883/255; lightness alone never
  qualifies another image.
- Original page bounds `[0, 0, 595.276, 841.89]` and effective drawing matrix
  `[278.0777114723683, 0, 0, 420.9433272, 158.5986023, 210.4725037]`, within
  0.01 point. This is a centered checkmark about half a page high, not a blanket
  exemption for page-sized images. Mirrored, rotated, resized or moved copies
  do not qualify.
- At least ten **distinct pages** meeting all of those checks within the PDF.

Only those individual image draws are ignored by the text graphics check.
Unknown pixels, other images, masks, grouped images, and non-blank drawings
remain fallback reasons. The PDF, operator lists and image renderer are
unchanged: **all 826 fallback images retain their original watermarks**. The
per-bank evidence (hash, placement and pages) is recorded in `text-review.json`.

Round 2 adds 157 question texts and 12 passage texts. All 25 autumn/winter 2020
contact sheets were personally compared, plus the 14 changed-layout sheets in
the earlier banks. Another 33 byte-identical sheets inherit round 1's review.
The four earlier banks' complete manifest objects remain unchanged. Underlines
and choices whose distinguishing meaning is emphasis-only remain image-only.

The only importer change for this work is a non-quantitative crop-margin fix:
exclude the repeated outer-page vector ornaments. Quantitative bounds stay wide
so the text bounds cannot clip figures.
