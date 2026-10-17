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
  if (line.size < 12) return null;
  const compact = line.compact.replace(/\s/g, '');
  if (/קטעיקריאה|קטעקריאה|קטע[אב](?![א-ת])|הבנתהנקרא|readingcomprehension/i.test(compact)) return 'shared-reading';
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
      // Also retain inner-column markers, so multi-column layouts fail closed.
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

/** Text positions only; safe to call with a pdf.js PDFDocumentProxy in Node. */
export async function findQuestions(pdfDocument) {
  const pages = [];
  for (let n = 1; n <= pdfDocument.numPages; n++) pages.push(await readPage(pdfDocument, n));
  const { answers, evidence } = readAnswerKey(pages);
  const chapters = new Map();
  for (const page of pages) {
    if (keyTitle(page)) continue;
    const header = page.lines.find(l => l.y > page.view[3] - page.height * 0.12 && chapterOf(l.text));
    if (!header) continue; // excludes contents, writing task, sample essays, and scoring pages
    const chapter = chapterOf(header.text), id = chapterId(chapter);
    if (!chapters.has(id)) chapters.set(id, { ...chapter, pages: [] });
    chapters.get(id).pages.push(page);
  }
  if (!chapters.size) throw new Error('Test chapters not found: expected verbal, quantitative or English chapter headers (פרק ראשון/שני).');
  const questions = [], skipped = [], seen = new Set();
  for (const chapter of chapters.values()) {
    const headings = chapter.pages.flatMap(p => p.lines.map(line => ({ ...line, page: p.number,
      kind: headingKind(line), range: rangeOf(line) })).filter(h => h.kind));
    const boundaries = chapter.pages.flatMap(p => p.lines.map(line => ({ ...line, page: p.number }))
      .filter(line => headingKind(line) || /הוראותלשאלות|לשאלותהוראות|instructionsforquestions/i.test(line.compact.replace(/\s/g, ''))));
    const allMarkers = chapter.pages.flatMap(p => questionMarkers(p, chapter.section).map(m => ({ ...m, page: p.number })));
    const duplicates = new Set(allMarkers.filter((m, i) => allMarkers.some((other, j) => j !== i && other.number === m.number)).map(m => m.number));
    for (const page of chapter.pages) {
      const markers = allMarkers.filter(m => m.page === page.number);
      const multicolumn = markers.length > 1 && Math.max(...markers.map(m => m.x)) - Math.min(...markers.map(m => m.x)) > page.width * 0.2;
      for (let index = 0; index < markers.length; index++) {
        const marker = markers[index], next = markers[index + 1];
        const id = `${chapterId(chapter)}-${marker.number}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const skip = reason => skipped.push({ id, page: page.number, reason });
        const shared = headings.find(h => h.kind.startsWith('shared') && h.range && marker.number >= h.range[0] && marker.number <= h.range[1]);
        const preceding = headings.filter(h => h.page < marker.page || h.page === marker.page && h.y > marker.y).at(-1);
        if (shared || preceding?.kind.startsWith('shared') && !preceding.range) { skip(shared?.kind ?? preceding.kind); continue; }
        if (!answers.has(id)) { skip('unverified-answer'); continue; }
        if (duplicates.has(marker.number)) { skip('ambiguous-number'); continue; }
        if (multicolumn) { skip('column-crossing'); continue; }
        // Without a recognized standalone heading, do not guess whether a stem
        // refers to a passage/figure on an earlier page.
        if (!preceding || preceding.kind !== 'standalone') { skip('unknown-question-group'); continue; }
        const betweenHeading = boundaries.find(h => h.page === page.number && h.y < marker.y && (!next || h.y > next.y));
        const lowerBoundary = Math.max(page.view[1] + 65, next ? next.top + 6 : 0, betweenHeading ? betweenHeading.top + 6 : 0);
        const upperBoundary = Math.min(page.view[3] - 65, marker.y + 13,
          preceding.page === page.number ? preceding.bottom - 3 : Infinity);
        const items = page.items.filter(i => i.y >= lowerBoundary && i.y <= upperBoundary);
        const choices = choiceMarkers(items);
        if (![1, 2, 3, 4].every(n => choices.filter(c => c.number === n).length === 1)) {
          skip('incomplete-or-ambiguous-choices'); continue;
        }
        if (choices.some(c => c.y > marker.y + 2)) { skip('column-crossing'); continue; }
        if (!next) {
          const followingPage = chapter.pages.find(p => p.number === page.number + 1);
          if (followingPage) {
            const followingMarker = allMarkers.find(m => m.page === followingPage.number);
            const floor = followingMarker ? followingMarker.top + 6 : followingPage.view[1] + 65;
            const ceiling = followingPage.view[3] - 65;
            const groupStarts = headings.some(h => h.page === followingPage.number && h.y >= floor && h.y <= ceiling);
            const continuation = followingPage.items.some(i => !i.rotated && i.size >= 10.5 && i.size <= marker.size * 1.2 && i.y >= floor && i.y <= ceiling &&
              !/עמוד ריק|blank page/i.test(i.text));
            // Even four markers do not prove that choice (4)'s wrapped text
            // ends on this page. Look for unnumbered continuation on the next.
            if (!groupStarts && continuation) { skip('page-or-question-crossing'); continue; }
          }
        }
        // A missing successor in the sequence can mean that the question spills
        // across the next page; four choices must all be inside this one slice.
        if (!items.length) { skip('empty-question'); continue; }
        const top = Math.min(upperBoundary + 3, Math.max(...items.map(i => i.top)) + 4);
        const oneRow = Math.max(...choices.map(c => c.y)) - Math.min(...choices.map(c => c.y)) < 3;
        const numericRow = oneRow && items.filter(i => Math.abs(i.y - choices[0].y) < 8)
          .every(i => /^[\d()±+−–\-*/=<>:%.,\s]+$/.test(i.text));
        const figureChoices = !numericRow && (oneRow ||
          Math.max(...choices.map(c => c.x)) - Math.min(...choices.map(c => c.x)) > page.width * 0.16);
        // At this font size NITE's accessible diagrams sometimes contain
        // invisible, displaced labels. Use the stem/choice font to tighten a
        // vertical layout; keep the whole slice for horizontal/figure choices.
        const bodyItems = items.filter(i => !i.rotated && i.size >= 10.5 && i.size <= marker.size * 1.2);
        const contentBottom = Math.min(...bodyItems.map(i => i.bottom)) - (chapter.section === 'quantitative' ? 10 : 4);
        const bottom = figureChoices ? lowerBoundary : Math.max(lowerBoundary, contentBottom);
        if (top <= bottom || bodyItems.some(i => i.bottom < lowerBoundary - 1)) { skip('page-or-question-crossing'); continue; }
        // Keep the entire printable width: unlabeled vector diagrams do not
        // appear in getTextContent and cannot be bounded using text alone.
        const x = page.view[0] + page.width * 0.065;
        questions.push({ id, section: chapter.section, chapter: chapter.chapter, number: marker.number,
          answer: answers.get(id), page: page.number,
          box: { x, y: bottom, width: page.width * 0.87, height: top - bottom } });
      }
    }
    // Every answer-key entry gets either a region or a diagnostic, even if the
    // number/stem itself could not be recovered from the text layer.
    for (const id of answers.keys()) {
      if (id.startsWith(`${chapterId(chapter)}-`) && !seen.has(id)) {
        seen.add(id);
        const number = Number(id.split('-').at(-1));
        const shared = headings.find(h => h.kind.startsWith('shared') && h.range && number >= h.range[0] && number <= h.range[1]);
        skipped.push({ id, page: shared?.page ?? null, reason: shared?.kind ?? 'question-number-not-found' });
      }
    }
  }
  for (const id of answers.keys()) {
    if (!seen.has(id)) skipped.push({ id, page: null, reason: 'chapter-not-found' });
  }
  diagnostics.set(pdfDocument, { skipped, answerKey: evidence,
    chapters: [...chapters.keys()], answerCount: answers.size });
  return { title: titleOf(pages), questions };
}

function canvasBlob(canvas, type) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob)
    : reject(new Error(`Could not encode question image as ${type}.`)), type, 0.94));
}

/** Render with the page viewport so rotations and nonzero CropBox origins work. */
export async function renderQuestion(pdfDocument, region, scale = 2) {
  if (typeof document === 'undefined') throw new Error('renderQuestion requires a browser canvas.');
  if (!(Number.isFinite(scale) && scale > 0)) throw new Error('Render scale must be a positive finite number.');
  const page = await pdfDocument.getPage(region.page);
  const { x, y, width, height } = region.box;
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0 ||
    x < page.view[0] || y < page.view[1] || x + width > page.view[2] + 0.01 || y + height > page.view[3] + 0.01) {
    throw new Error(`Question ${region.id} has an invalid or out-of-page crop box.`);
  }
  const viewport = page.getViewport({ scale });
  const rect = [...viewport.convertToViewportPoint(x, y), ...viewport.convertToViewportPoint(x + width, y + height)];
  const left = Math.floor(Math.min(rect[0], rect[2])), top = Math.floor(Math.min(rect[1], rect[3]));
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(Math.max(rect[0], rect[2])) - left;
  canvas.height = Math.ceil(Math.max(rect[1], rect[3])) - top;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('A 2D canvas context is required to render questions.');
  try {
    // Translate the full-page viewport into a crop-sized canvas: avoids holding
    // a second full-page bitmap for each question on memory-constrained phones.
    await page.render({ canvasContext: context, viewport, transform: [1, 0, 0, 1, -left, -top], background: '#fff' }).promise;
    try { return await canvasBlob(canvas, 'image/webp'); }
    catch { return await canvasBlob(canvas, 'image/png'); }
  } finally { canvas.width = canvas.height = 0; }
}

/** onProgress receives { phase, completed, total }; images are rendered serially. */
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
    const questions = [];
    for (const region of result.questions) {
      const image = await renderQuestion(pdfDocument, region);
      questions.push({ ...region, image });
      onProgress?.({ phase: 'render', completed: questions.length, total: result.questions.length });
    }
    return { title: result.title, questions };
  } finally { await loading.destroy(); }
}
