// NITE accessible, text-layer PDFs. All geometry is in unrotated PDF user space
// (origin at bottom left), not CSS pixels. No OCR or operator-list inspection.
const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/build/';
const diagnostics = new WeakMap();
let injectedPdfjs;

/** Optional dependency injection; importing this module never loads a CDN. */
export function setPdfjsModule(pdfjs) { injectedPdfjs = pdfjs; }

export function getImportDiagnostics(pdfDocument) {
  return diagnostics.get(pdfDocument) ?? null;
}

function clean(text) {
  return text.normalize('NFKC').replace(/[\u0591-\u05c7\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ').trim();
}

function chapterOf(text) {
  const t = clean(text);
  const section = /מילולית/.test(t) ? 'verbal' : /כמותית/.test(t) ? 'quantitative'
    : /אנגלית|english/i.test(t) ? 'english' : null;
  const chapter = /ראשון|first|chapter\s*1|section\s*1/i.test(t) ? 1
    : /שני|second|chapter\s*2|section\s*2/i.test(t) ? 2 : null;
  return section && chapter && /פרק|chapter|section/i.test(t) ? { section, chapter } : null;
}

function linesOf(items) {
  const lines = [];
  for (const item of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    let line = lines.find(l => Math.abs(l.y - item.y) < 1.8);
    if (!line) { line = { y: item.y, items: [] }; lines.push(line); }
    line.items.push(item);
  }
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    line.text = line.items.map(i => i.text).join(' ');
    line.compact = line.items.map(i => i.text).join('');
    line.top = Math.max(...line.items.map(i => i.top));
    line.bottom = Math.min(...line.items.map(i => i.bottom));
    line.size = Math.max(...line.items.map(i => i.size));
  }
  return lines.sort((a, b) => b.y - a.y);
}

async function readPage(document, number) {
  const page = await document.getPage(number);
  const content = await page.getTextContent();
  const items = content.items.filter(i => typeof i.str === 'string' && clean(i.str)).map(i => {
    const style = content.styles?.[i.fontName] ?? {};
    const size = Math.hypot(i.transform[2], i.transform[3]) || i.height || 1;
    const x = i.transform[4], y = i.transform[5];
    return { text: clean(i.str), x, y, width: i.width, size,
      top: y + size * (style.ascent ?? 0.9), bottom: y + size * (style.descent ?? -0.25),
      rotated: Math.abs(i.transform[1]) > 0.01 || Math.abs(i.transform[2]) > 0.01 };
  });
  const view = page.view;
  return { number, items, lines: linesOf(items), view, width: view[2] - view[0], height: view[3] - view[1] };
}

function keyTitle(page) {
  // The table of contents also names the key, but has small type and dot leaders.
  return page.lines.some(l => l.size >= 16 && /מפתח/.test(l.text) && /תשובות/.test(l.text)
    && /נכונות/.test(l.text));
}

function integer(item) { return /^\d{1,2}$/.test(item.text) ? Number(item.text) : null; }
function center(item) { return item.x + item.width / 2; }
function chapterId(chapter) { return `${chapter.section}-${chapter.chapter}`; }

function readAnswerKey(pages) {
  const answers = new Map(), evidence = [];
  for (const page of pages.filter(keyTitle)) {
    const headers = page.lines.map(line => ({ line, chapter: chapterOf(line.text) })).filter(h => h.chapter);
    for (let h = 0; h < headers.length; h++) {
      const { line: header, chapter } = headers[h];
      const floor = headers[h + 1]?.line.top ?? page.view[1] + 90;
      const rows = page.lines.filter(l => l.y < header.bottom && l.y > floor);
      const numberRow = rows.find(l => {
        const ns = l.items.map(integer).filter(n => n !== null).sort((a, b) => a - b);
        return ns.length >= 8 && ns.every((n, i) => n === i + 1);
      });
      if (!numberRow) continue;
      const cells = numberRow.items.filter(i => integer(i) !== null);
      const answerRows = rows.filter(l => l.y < numberRow.bottom && numberRow.y - l.y < 60);
      const answerRow = answerRows.find(l => l.items.filter(i => /^[1-4]$/.test(i.text)).length === cells.length);
      if (!answerRow) continue;
      const values = answerRow.items.filter(i => /^[1-4]$/.test(i.text));
      const pairs = cells.map(cell => {
        const matches = values.filter(v => Math.abs(center(v) - center(cell)) < 3);
        return matches.length === 1 ? { number: integer(cell), value: Number(matches[0].text),
          x: center(cell), numberY: numberRow.y, answerY: answerRow.y } : null;
      });
      // Reject the entire table if even one cell is unaligned or ambiguous.
      if (pairs.some(p => !p)) continue;
      for (const pair of pairs) {
        const id = `${chapterId(chapter)}-${pair.number}`;
        if (answers.has(id) && answers.get(id) !== pair.value - 1) {
          throw new Error(`Conflicting answer key entries for ${id}.`);
        }
        answers.set(id, pair.value - 1);
        evidence.push({ id, page: page.number, ...pair });
      }
    }
  }
  if (!answers.size) throw new Error('Answer key not found or unreadable: expected מפתח תשובות נכונות with aligned question/answer rows.');
  return { answers, evidence };
}

function headingKind(line) {
  const compact = line.compact.replace(/\s/g, '');
  // Small bold headers also introduce short shared verbal passages/puzzles.
  // Their PDF spans are RTL, so the range may precede or follow the wording.
  if (rangeOf(line) && /(?:נוגעות|מתייחסות|נוגעים|מתייחסים)לקטע(?:הבא|שלהלן)/.test(compact)) return 'shared-reading';
  if (line.size < 12) return null;
  if (/קטעיקריאה|קטעקריאה|קטע[אב](?![א-ת])|הבנתהנקרא|^readingcomprehension(?:\(|$)|^Text[IVX]+(?:\(|$)/i.test(compact)) return 'shared-reading';
  if (/הסקהמ(?:תרשים|טבלה)|(?:graph|table|chart)comprehension/i.test(compact)) return 'shared-chart';
  if (/אנלוגיות|שאלותובעיות|שאלותהבנהוהסקה|sentencecompletions|restatements/i.test(compact)) return 'standalone';
  return null;
}

function rangeOf(line) {
  const match = line.compact.replace(/\s/g, '').match(/(\d{1,2})[-–−](\d{1,2})/);
  return match ? [Math.min(+match[1], +match[2]), Math.max(+match[1], +match[2])] : null;
}

function questionMarkers(page, section) {
  const markers = [];
  for (const line of page.lines) {
    if (line.y < page.view[1] + 65 || line.y > page.view[3] - 65) continue;
    for (const item of line.items) {
      if (item.size < 11.5) continue; // excludes the numbered formula reference sheet
      let n = integer(item);
      const joined = item.text.match(/^(?:\.(\d{1,2})|(\d{1,2})\.)$/);
      if (joined) n = +(joined[1] ?? joined[2]);
      else if (n !== null && !line.items.some(i => i.text === '.' &&
        (Math.abs(i.x + i.width - item.x) < 2 || Math.abs(item.x + item.width - i.x) < 2))) continue;
      if (!(n >= 1 && n <= 50)) continue;
      const relativeX = (item.x - page.view[0]) / page.width;
      // NITE Hebrew numbers are at the right edge, English at the left edge.
      // Retain inner-column markers as well, to recover column continuations.
      if (section === 'english' ? relativeX > 0.58 : relativeX < 0.40 || relativeX > 0.94) continue;
      markers.push({ number: n, x: item.x, y: item.y, top: item.top, size: item.size });
    }
  }
  return markers.sort((a, b) => b.y - a.y || a.x - b.x);
}

function choiceMarkers(items) {
  const choices = [];
  for (const item of items) {
    for (const match of item.text.matchAll(/\(([1-4])\)|\)([1-4])\(/g)) {
      choices.push({ number: +(match[1] ?? match[2]), x: item.x, y: item.y });
    }
    if (!/^[1-4]$/.test(item.text)) continue;
    // Match the three separate PDF spans directly. Accessible diagram labels
    // can overlap them; concatenating every span on a row corrupts '(2)'.
    const peers = items.filter(i => Math.abs(i.y - item.y) < 0.6);
    const left = peers.filter(i => /^[()]$/.test(i.text) && Math.abs(i.x + i.width - item.x) < 2);
    const right = peers.filter(i => /^[()]$/.test(i.text) && Math.abs(item.x + item.width - i.x) < 2);
    if (left.length === 1 && right.length === 1 && left[0].text !== right[0].text) {
      choices.push({ number: +item.text, x: left[0].x, y: item.y });
    }
  }
  return choices;
}

function titleOf(pages) {
  const cover = pages.slice(0, 2).flatMap(p => p.items).map(i => i.text).join(' ');
  const year = cover.match(/20\d{2}/)?.[0];
  const season = cover.match(/אביב|קיץ|סתיו|חורף/)?.[0];
  return `בחינה פסיכומטרית${season ? ` — ${season}` : ''}${year ? ` ${year}` : ''}`;
}

// A flow slot is a printable column. Full-width is the default: text alone
// cannot bound vector diagrams. Split only with anchors or a persistent text
// gutter; Hebrew flows right to left, English left to right.
function flowOf(chapter) {
  return chapter.pages.flatMap(page => {
    const markers = questionMarkers(page, chapter.section);
    const xs = markers.map(m => m.x);
    // The outermost 7% contains repeating vector page ornaments. Keep those
    // out of textual crops (and their graphic-safety checks), but retain the
    // wider quantitative crop so figures cannot be cut to text bounds.
    const margin = chapter.section === 'quantitative' ? 0.065 : 0.09;
    const left = page.view[0] + page.width * margin, right = page.view[0] + page.width * (1 - margin);
    const mid = page.view[0] + page.width / 2;
    const text = page.items.filter(i => !i.rotated && i.y >= page.view[1] + 65 &&
      i.y <= page.view[3] - 65 && i.width >= page.width * 0.14 && /[א-תA-Za-z]{3}/.test(i.text));
    // Passage-only pages have no question anchors. A persistent empty gutter
    // with at least three text lines on either side also proves two columns.
    const textColumns = text.filter(i => i.x + i.width <= mid - 4).length >= 3 &&
      text.filter(i => i.x >= mid + 4).length >= 3 &&
      !text.some(i => i.x < mid - 4 && i.x + i.width > mid + 4);
    const split = textColumns || xs.length > 1 && Math.max(...xs) - Math.min(...xs) > page.width * 0.2;
    const columns = split ? [[left, mid], [mid, right]] : [[left, right]];
    if (split && chapter.section !== 'english') columns.reverse();
    return columns.map(([x, end]) => {
      const items = page.items.filter(i => center(i) >= x && center(i) < end &&
        i.y >= page.view[1] + 65 && i.y <= page.view[3] - 65 && !/עמוד ריק|blank page/i.test(i.text));
      return { page: page.number, x, width: end - x, top: page.view[3] - 65,
        bottom: page.view[1] + 65, items, lines: linesOf(items),
        markers: markers.filter(m => m.x >= x && m.x < end) };
    });
  }).map((slot, index) => ({ ...slot, slot: index }));
}

function before(a, b) { return a.slot < b.slot || a.slot === b.slot && a.y > b.y; }
function questionHeading(line) {
  // Displaced accessible diagram labels may share the heading's baseline.
  // A word-sized span inside "answer the following questions" is not a heading.
  return line.items.some(i => i.size >= 12 && /^(?:השאלות|Questions)\s*:?$/i.test(i.text));
}
function instructionHeading(line) {
  return /הוראותלשאלות|לשאלותהוראות|instructionsforquestions/i.test((line.compact ?? '').replace(/\s/g, ''));
}

// Collect separate page/column slices. Endpoints use glyph extents rather than
// baselines, so neither a following heading nor the next stem enters a crop.
function slicesBetween(flow, start, end) {
  const slices = [];
  for (const slot of flow) {
    if (slot.slot < start.slot || end && slot.slot > end.slot) continue;
    const top = slot.slot === start.slot ? Math.min(slot.top, start.top + 4) : slot.top;
    const bottom = end && slot.slot === end.slot ? Math.max(slot.bottom, end.top + 6) : slot.bottom;
    const items = slot.items.filter(i => i.y <= top && i.y >= bottom);
    if (items.length && top > bottom) slices.push({ ...slot, top, bottom, items });
  }
  return slices;
}

function cropSlice(slice, { chart = false, figure = false, quantitative = false } = {}) {
  const body = slice.items.filter(i => !i.rotated && i.size >= 10.5 && i.size <= 17);
  if (!body.length) return null;
  const top = Math.min(slice.top, Math.max(...slice.items.map(i => i.top)) + 4);
  const bottom = chart || figure ? slice.bottom : Math.max(slice.bottom,
    Math.min(...body.map(i => i.bottom)) - (quantitative ? 10 : 4));
  return top > bottom ? { page: slice.page,
    box: { x: slice.x, y: bottom, width: slice.width, height: top - bottom } } : null;
}

/** Text positions only; safe to call with a pdf.js PDFDocumentProxy in Node.
 * Regions retain page/box as aliases for parts[0]. Contexts never include stems.
 */
export async function findQuestions(pdfDocument) {
  const pages = [];
  for (let n = 1; n <= pdfDocument.numPages; n++) pages.push(await readPage(pdfDocument, n));
  const { answers, evidence } = readAnswerKey(pages);
  const chapters = new Map();
  for (const page of pages) {
    if (keyTitle(page)) continue;
    const header = page.lines.find(l => l.y > page.view[3] - page.height * 0.12 && chapterOf(l.text));
    if (!header) continue; // contents, writing task, essays, and scoring pages
    const chapter = chapterOf(header.text), id = chapterId(chapter);
    if (!chapters.has(id)) chapters.set(id, { ...chapter, pages: [] });
    chapters.get(id).pages.push(page);
  }
  if (!chapters.size) throw new Error('Test chapters not found: expected verbal, quantitative or English chapter headers (פרק ראשון/שני).');
  const questions = [], contexts = [], skipped = [], contextSkipped = [], seen = new Set();
  for (const chapter of chapters.values()) {
    const flow = flowOf(chapter);
    const lines = flow.flatMap(slot => slot.lines.map(line => ({ ...line, slot: slot.slot, page: slot.page })));
    const headings = lines.map(line => ({ ...line, kind: headingKind(line), range: rangeOf(line) })).filter(h => h.kind);
    const boundaries = lines.filter(line => headingKind(line) || questionHeading(line) || instructionHeading(line));
    const markers = flow.flatMap(slot => slot.markers.map(m => ({ ...m, slot: slot.slot, page: slot.page })));
    const duplicates = new Set(markers.filter((m, i) => markers.some((other, j) => j !== i && other.number === m.number)).map(m => m.number));
    const groups = [], counters = { passage: 0, chart: 0 };
    for (let i = 0; i < headings.length; i++) {
      const heading = headings[i], next = headings[i + 1];
      if (!heading.kind.startsWith('shared')) continue;
      // English's "Reading Comprehension" is a parent instruction, not a
      // third passage. Text I and Text II each get those instructions prepended.
      if (!heading.range && next?.kind === heading.kind && next.range) continue;
      const kind = heading.kind === 'shared-reading' ? 'passage' : 'chart';
      const id = `${chapterId(chapter)}-${kind}-${++counters[kind]}`;
      const stop = [...boundaries, ...markers].filter(b => before(heading, b))
        .sort((a, b) => a.slot - b.slot || b.y - a.y)
        .find(b => !instructionHeading(b));
      const slices = slicesBetween(flow, heading, stop);
      // A bare shared heading immediately followed by a question is unresolved,
      // not a passage. Never attach a fabricated/empty context.
      const body = slices.flatMap(s => s.items.filter(item => s.slot !== heading.slot || item.y < heading.bottom - 3));
      const meaningful = body.some(i => i.size >= 10.5 && /[א-תA-Za-z]{3}/.test(i.text));
      let parts = meaningful ? slices.map(s => cropSlice(s, { chart: kind === 'chart' })).filter(Boolean) : [];
      if (kind === 'passage' && /^Text\s+[IVX]+/i.test(heading.text)) {
        const parent = headings.slice(0, i).reverse().find(h => h.kind === 'shared-reading' && /reading\s*comprehension/i.test(h.text));
        const firstText = parent && headings.find(h => before(parent, h) && /^Text\s+[IVX]+/i.test(h.text));
        if (parent && firstText) parts = [...slicesBetween(flow, parent, firstText).map(s => cropSlice(s)).filter(Boolean), ...parts];
        else parts = []; // passage instructions could not be resolved
      }
      const context = { id, kind, section: chapter.section, chapter: chapter.chapter, parts, questionIds: [] };
      groups.push({ heading, next, context, valid: meaningful && parts.length > 0 });
      if (!meaningful || !parts.length) contextSkipped.push({ id, page: heading.page, reason: 'unresolved-context' });
    }
    for (let index = 0; index < markers.length; index++) {
      const marker = markers[index], id = `${chapterId(chapter)}-${marker.number}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const skip = reason => skipped.push({ id, page: marker.page, reason });
      if (!answers.has(id)) { skip('unverified-answer'); continue; }
      if (duplicates.has(marker.number)) { skip('ambiguous-number'); continue; }
      // A short shared introduction applies only to its printed range; later
      // standalone questions resume the enclosing group's instructions.
      const preceding = headings.filter(h => before(h, marker) &&
        (!h.range || marker.number >= h.range[0] && marker.number <= h.range[1])).at(-1);
      const group = groups.find(g => before(g.heading, marker) && (!g.next || before(marker, g.next)) &&
        (!g.heading.range || marker.number >= g.heading.range[0] && marker.number <= g.heading.range[1]));
      if (preceding?.kind.startsWith('shared') && (!group || !group.valid)) { skip('unresolved-context'); continue; }
      if (!preceding || !group && preceding.kind !== 'standalone') { skip('unknown-question-group'); continue; }
      const end = [...boundaries, markers[index + 1]].filter(b => b && before(marker, b))
        .sort((a, b) => a.slot - b.slot || b.y - a.y)[0];
      const slices = slicesBetween(flow, marker, end);
      const choices = slices.flatMap(s => choiceMarkers(s.items).map(c => ({ ...c, slot: s.slot })));
      if (![1, 2, 3, 4].every(n => choices.filter(c => c.number === n).length === 1)) {
        skip('incomplete-or-ambiguous-choices'); continue;
      }
      const oneRow = choices.every(c => c.slot === choices[0].slot && Math.abs(c.y - choices[0].y) < 3);
      const numericRow = oneRow && slices.flatMap(s => s.slot === choices[0].slot ? s.items.filter(i => Math.abs(i.y - choices[0].y) < 8) : [])
        .every(i => /^[\d()±+−–\-*/=<>:%.,\s]+$/.test(i.text));
      const figure = !numericRow && (oneRow || Math.max(...choices.map(c => c.x)) - Math.min(...choices.map(c => c.x)) > flow[marker.slot].width * 0.16);
      const parts = slices.map(s => cropSlice(s, { figure, quantitative: chapter.section === 'quantitative' })).filter(Boolean);
      if (!parts.length) { skip('empty-question'); continue; }
      questions.push({ id, section: chapter.section, chapter: chapter.chapter, number: marker.number,
        answer: answers.get(id), ...parts[0], parts, context: group?.context.id ?? null });
      group?.context.questionIds.push(id);
    }
    for (const group of groups) {
      if (group.valid && group.context.questionIds.length) {
        group.context.questionIds.sort((a, b) => Number(a.split('-').at(-1)) - Number(b.split('-').at(-1)));
        contexts.push(group.context);
      }
    }
    for (const id of answers.keys()) {
      if (id.startsWith(`${chapterId(chapter)}-`) && !seen.has(id)) {
        seen.add(id);
        skipped.push({ id, page: null, reason: 'question-number-not-found' });
      }
    }
  }
  for (const id of answers.keys()) {
    if (!seen.has(id)) skipped.push({ id, page: null, reason: 'chapter-not-found' });
  }
  // The chapter Map preserves test order; within a chapter use printed numbers,
  // not y-coordinate order (which is wrong for side-by-side questions).
  const order = [...chapters.keys()];
  questions.sort((a, b) => order.indexOf(chapterId(a)) - order.indexOf(chapterId(b)) || a.number - b.number);
  diagnostics.set(pdfDocument, { skipped, contextSkipped, answerKey: evidence,
    ignored: pages.filter(p => p.lines.some(l => l.size >= 14 && /מטלת כתיבה/.test(l.text)))
      .map(p => ({ page: p.number, reason: 'writing-task' })),
    chapters: order, answerCount: answers.size });
  return { title: titleOf(pages), questions, contexts };
}

// Ink is darker than the NITE watermark, so the trim keeps the text and drops the empty page margin.
// Same values as tools/build-banks-render.py.
const INK_LEVEL = 170, TRIM_MARGIN = 16;

/** A copy of the canvas without its empty margins, or the canvas itself when it has no ink. */
function trimmed(canvas) {
  const { width, height } = canvas;
  const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  let left = width, right = -1, top = height, bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] >= INK_LEVEL) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (right < 0) return canvas;
  left = Math.max(0, left - TRIM_MARGIN); top = Math.max(0, top - TRIM_MARGIN);
  right = Math.min(width - 1, right + TRIM_MARGIN); bottom = Math.min(height - 1, bottom + TRIM_MARGIN);
  const out = document.createElement('canvas');
  out.width = right - left + 1; out.height = bottom - top + 1;
  out.getContext('2d').drawImage(canvas, left, top, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

function canvasBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob)
    : reject(new Error(`Could not encode image as ${type}.`)), type, quality));
}

/** Render all parts in reading order, using viewports for rotation/CropBox.
 * Also accepts legacy {page, box}. Each image is <=8000px tall and <=1MB.
 */
export async function renderQuestion(pdfDocument, region, scale = 2) {
  if (typeof document === 'undefined') throw new Error('renderQuestion requires a browser canvas.');
  if (!(Number.isFinite(scale) && scale > 0)) throw new Error('Render scale must be a positive finite number.');
  const parts = region.parts ?? [{ page: region.page, box: region.box }];
  if (!parts.length) throw new Error(`Region ${region.id} has no crop parts.`);
  const sources = [];
  for (const part of parts) {
    const page = await pdfDocument.getPage(part.page), { x, y, width, height } = part.box;
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0 ||
      x < page.view[0] || y < page.view[1] || x + width > page.view[2] + 0.01 || y + height > page.view[3] + 0.01) {
      throw new Error(`Region ${region.id} has an invalid or out-of-page crop box.`);
    }
    sources.push({ page, box: part.box });
  }
  const geometry = factor => sources.map(({ page, box: { x, y, width, height } }) => {
    const viewport = page.getViewport({ scale: factor });
    const rect = [...viewport.convertToViewportPoint(x, y), ...viewport.convertToViewportPoint(x + width, y + height)];
    const left = Math.floor(Math.min(rect[0], rect[2])), top = Math.floor(Math.min(rect[1], rect[3]));
    return { page, viewport, left, top, width: Math.ceil(Math.max(rect[0], rect[2])) - left,
      height: Math.ceil(Math.max(rect[1], rect[3])) - top };
  });
  let factor = Math.min(scale, 2), encoded = false;
  for (let attempt = 0; attempt < 24; attempt++) {
    const crops = geometry(factor), height = crops.reduce((sum, c) => sum + c.height, 0);
    if (height > 8000) { factor *= (8000 - parts.length) / height; continue; }
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(...crops.map(c => c.width)); canvas.height = height;
    try {
      const context = canvas.getContext('2d');
      if (!context) throw new Error('A 2D canvas context is required to render images.');
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
      let offset = 0;
      for (const crop of crops) {
        const partCanvas = document.createElement('canvas');
        partCanvas.width = crop.width; partCanvas.height = crop.height;
        try {
          const partContext = partCanvas.getContext('2d');
          if (!partContext) throw new Error('A 2D canvas context is required to render images.');
          await crop.page.render({ canvasContext: partContext, viewport: crop.viewport,
            transform: [1, 0, 0, 1, -crop.left, -crop.top], background: '#fff' }).promise;
          context.drawImage(partCanvas, region.section === 'english' ? 0 : canvas.width - crop.width, offset);
        } finally { partCanvas.width = partCanvas.height = 0; }
        offset += crop.height;
      }
      const output = trimmed(canvas);
      for (const quality of [0.85, 0.7, 0.55, 0.4, 0.25]) {
        let blob;
        try { blob = await canvasBlob(output, 'image/webp', quality); }
        catch { blob = await canvasBlob(output, 'image/png'); }
        encoded = true;
        if (blob.size <= 1_000_000) return blob;
        if (blob.type !== 'image/webp') break; // PNG ignores quality
      }
    } finally { canvas.width = canvas.height = 0; }
    factor *= 0.8;
    if (factor < 0.05) break;
  }
  throw new Error(`${encoded ? 'image-size-limit' : 'image-render-failed'}: ${region.id} could not fit within 1,000,000 bytes.`);
}

/** onProgress receives { phase, completed, total }, plus id/page/reason on skip
 * events. Scan exclusions and render failures are both reported. Images render
 * serially; a failed context excludes all its questions.
 */
export async function importPdf(arrayBuffer, onProgress, pdfjsModule = injectedPdfjs) {
  const pdfjs = pdfjsModule ?? await import(`${PDFJS_URL}pdf.min.mjs`);
  if (pdfjs.GlobalWorkerOptions && !pdfjsModule) {
    pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS_URL}pdf.worker.min.mjs`;
  }
  onProgress?.({ phase: 'scan', completed: 0, total: 1 });
  const loading = pdfjs.getDocument({ data: new Uint8Array(arrayBuffer) });
  let pdfDocument;
  try {
    pdfDocument = await loading.promise;
    const result = await findQuestions(pdfDocument);
    onProgress?.({ phase: 'scan', completed: 1, total: 1 });
    const questions = [], contexts = [], failedContexts = new Set();
    const diagnostic = getImportDiagnostics(pdfDocument);
    let completed = 0;
    const total = result.questions.length + result.contexts.length;
    for (const exclusion of [...diagnostic.skipped, ...diagnostic.contextSkipped, ...diagnostic.ignored]) {
      onProgress?.({ ...exclusion, phase: 'skip', completed, total });
    }
    const reportSkip = (region, error, isContext = false) => {
      const reason = error.message.startsWith('image-size-limit') ? 'image-size-limit' : 'image-render-failed';
      (isContext ? diagnostic.contextSkipped : diagnostic.skipped).push({ id: region.id,
        page: region.page ?? region.parts[0]?.page, reason, detail: error.message });
      onProgress?.({ phase: 'skip', id: region.id, reason, completed, total });
    };
    for (const region of result.contexts) {
      try { contexts.push({ ...region, image: await renderQuestion(pdfDocument, region) }); }
      catch (error) { failedContexts.add(region.id); reportSkip(region, error, true); }
      onProgress?.({ phase: 'render', completed: ++completed, total });
    }
    for (const region of result.questions) {
      if (region.context && failedContexts.has(region.context)) {
        diagnostic.skipped.push({ id: region.id, page: region.page, reason: 'missing-context' });
        onProgress?.({ phase: 'skip', id: region.id, reason: 'missing-context', completed, total });
      } else {
        try { questions.push({ ...region, image: await renderQuestion(pdfDocument, region) }); }
        catch (error) { reportSkip(region, error); }
      }
      onProgress?.({ phase: 'render', completed: ++completed, total });
    }
    const keptIds = new Set(questions.map(q => q.id));
    for (const context of contexts) context.questionIds = context.questionIds.filter(id => keptIds.has(id));
    return { title: result.title, questions, contexts: contexts.filter(c => c.questionIds.length) };
  } finally { await loading.destroy(); }
}
