// node tools/build-banks.mjs [pdf folder] [out folder]
// Requires tools/node_modules (as import-check.mjs does) and uv on PATH.
// Replaces the output directory. Manifest file paths are relative to each bank's folder.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir, rm, realpath, lstat, stat } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { findQuestions, getImportDiagnostics } from '../site/import.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const seasons = ['spring', 'summer', 'autumn', 'winter'];
const hebrew = ['אביב', 'קיץ', 'סתיו', 'חורף'];
const sections = ['verbal', 'quantitative', 'english'];
const countBy = (items, key) => items.reduce((counts, item) => {
  counts[item[key]] = (counts[item[key]] ?? 0) + 1;
  return counts;
}, {});
const contains = (parent, child) => {
  const path = relative(parent, child);
  return path === '' || !isAbsolute(path) && path !== '..' && !path.startsWith('../');
};

// Resolve existing ancestors too: a symlink must not bypass deletion guards.
async function canonical(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return join(await canonical(dirname(path)), parse(path).base);
  }
}

async function validateRegions(document, result, diagnostic) {
  assert(result.questions.length, 'No verified questions found');
  const answers = new Map(diagnostic.answerKey.map(e => [e.id, e.value - 1]));
  const contextIds = new Set(result.contexts.map(c => c.id));
  const questionIds = new Set(result.questions.map(q => q.id));
  assert.equal(contextIds.size, result.contexts.length, 'Duplicate context id');
  assert.equal(questionIds.size, result.questions.length, 'Duplicate question id');
  assert.equal(result.questions.length + diagnostic.skipped.length, diagnostic.answerCount,
    'Every answer-key entry must be kept or explicitly skipped');
  let previous = -1;
  for (const q of result.questions) {
    assert(sections.includes(q.section), `Invalid section: ${q.id}`);
    assert(Number.isInteger(q.answer) && q.answer >= 0 && q.answer <= 3 && answers.get(q.id) === q.answer,
      `Unverified answer: ${q.id}`);
    assert(q.context === null || contextIds.has(q.context), `Missing context: ${q.id}`);
    const chapter = diagnostic.chapters.indexOf(`${q.section}-${q.chapter}`);
    assert(chapter >= 0 && Number.isInteger(q.number) && q.number >= 1 && q.number <= 50);
    const order = chapter * 100 + q.number;
    assert(order > previous, `Questions not in test order: ${q.id}`);
    previous = order;
  }
  for (const c of result.contexts) {
    assert(['passage', 'chart'].includes(c.kind), `Invalid context kind: ${c.id}`);
    const linked = result.questions.filter(q => q.context === c.id).map(q => q.id);
    assert(linked.length, `Unused context: ${c.id}`);
    assert.deepEqual(c.questionIds, linked, `Inconsistent context links: ${c.id}`);
  }
  for (const region of [...result.questions, ...result.contexts]) {
    assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(region.id), `Unsafe region id: ${region.id}`);
    assert(Array.isArray(region.parts) && region.parts.length, `Missing crop parts: ${region.id}`);
    for (const { page: number, box: b } of region.parts) {
      assert(Number.isInteger(number) && number >= 1 && number <= document.numPages, `Invalid page: ${region.id}`);
      const page = await document.getPage(number);
      assert(b && [b.x, b.y, b.width, b.height].every(Number.isFinite) && b.width > 0 && b.height > 0 &&
        b.x >= page.view[0] && b.y >= page.view[1] && b.x + b.width <= page.view[2] + 0.01 &&
        b.y + b.height <= page.view[3] + 0.01, `Invalid crop: ${region.id}`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 2 || args.some(a => a.startsWith('--'))) {
    throw new Error('Usage: node tools/build-banks.mjs [pdf folder] [out folder]');
  }
  const input = await realpath(resolve(args[0] ?? join(root, '../_shared/nite-public')));
  const outputPath = resolve(args[1] ?? join(root, 'site/banks'));
  const outputEntry = await lstat(outputPath).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  assert(!outputEntry?.isSymbolicLink(), 'Output directory must not be a symlink');
  assert(!outputEntry || outputEntry.isDirectory(), 'Output path must be a directory');
  const output = await canonical(outputPath);
  const repository = await realpath(root);
  assert(output !== parse(output).root && !contains(output, repository) &&
    !contains(output, input) && !contains(input, output) &&
    !contains(output, join(repository, 'site')) && !contains(output, join(repository, 'worker')) &&
    !contains(join(repository, '.git'), output) && !contains(join(repository, 'tools'), output),
  `Refusing unsafe output directory: ${output} (must not overlap the PDF input or contain project sources)`);
  const entries = (await readdir(input, { withFileTypes: true }))
    .filter(e => /\.pdf$/i.test(e.name)).sort((a, b) => a.name.localeCompare(b.name));
  assert(entries.length, `No PDFs found in ${input}`);
  const ids = new Set();
  const sources = entries.map(entry => {
    assert(entry.isFile(), `PDF must be a regular file: ${entry.name}`);
    const match = entry.name.match(/^psychometric_(spring|summer|autumn|winter)_(\d{4})(?:_[a-z0-9]+)*\.pdf$/i);
    assert(match, `Unrecognized PDF name: ${entry.name}; expected psychometric_<spring|summer|autumn|winter>_<year>[_suffix].pdf`);
    const season = match[1].toLowerCase(), year = Number(match[2]), id = `nite-${match[2]}-${season}`;
    assert(!ids.has(id), `Duplicate bank id ${id}: more than one PDF has the same year and season`);
    ids.add(id);
    return { id, year, season, source: entry.name, title: `מאל"ו · ${hebrew[seasons.indexOf(season)]} ${year}` };
  }).sort((a, b) => a.year - b.year || seasons.indexOf(a.season) - seasons.indexOf(b.season));

  // Scan and validate all PDFs before deleting any previous output.
  const scanned = [];
  for (const source of sources) {
    const loading = getDocument({ data: new Uint8Array(await readFile(join(input, source.source))),
      standardFontDataUrl: join(here, 'node_modules/pdfjs-dist/standard_fonts/'),
      cMapUrl: join(here, 'node_modules/pdfjs-dist/cmaps/'), cMapPacked: true,
      wasmUrl: join(here, 'node_modules/pdfjs-dist/wasm/') });
    try {
      const document = await loading.promise;
      const result = await findQuestions(document), diagnostic = getImportDiagnostics(document);
      await validateRegions(document, result, diagnostic);
      scanned.push({ source, result, diagnostic });
    } catch (error) { throw new Error(`${source.source}: ${error.message}`, { cause: error }); }
    finally { await loading.destroy(); }
  }
  const uv = spawnSync('uv', ['--version'], { encoding: 'utf8' });
  assert(!uv.error && uv.status === 0, `uv is required: ${uv.error?.message ?? uv.stderr}`);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const banks = [];
  let totalBytes = 0, imageCount = 0;
  for (const { source, result, diagnostic } of scanned) {
    const directory = join(output, source.id);
    await mkdir(directory);
    const questions = result.questions.map(q => ({ id: q.id, section: q.section, answer: q.answer,
      context: q.context, file: `q-${q.id}.webp` }));
    const contexts = result.contexts.map(c => ({ id: c.id, kind: c.kind, file: `c-${c.id}.webp` }));
    const regions = [...result.questions.map(q => ({ ...q, file: `q-${q.id}.webp` })),
      ...result.contexts.map(c => ({ ...c, file: `c-${c.id}.webp` }))];
    const rendered = spawnSync('uv', ['run', '--script', join(here, 'build-banks-render.py'),
      join(input, source.source), directory], {
      input: JSON.stringify(regions), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    });
    assert(!rendered.error && rendered.status === 0,
      `${source.id}: uv renderer failed: ${rendered.error?.message ?? rendered.stderr}`);
    const report = JSON.parse(rendered.stdout);
    const expected = regions.map(r => r.file).sort();
    assert.deepEqual(report.images.map(i => i.file).sort(), expected, 'Renderer did not produce every image');
    assert.deepEqual((await readdir(directory)).sort(), expected, 'Unexpected or missing output files');
    let bytes = 0;
    for (const image of report.images) {
      const info = await stat(join(directory, image.file));
      assert(info.isFile() && info.size > 0 && info.size <= 1_000_000 && info.size === image.bytes &&
        image.height > 0 && image.height <= 8000 && image.width > 0, `Invalid image: ${image.file}`);
      bytes += info.size;
    }
    banks.push({ id: source.id, title: source.title, source: source.source, questions, contexts });
    totalBytes += bytes; imageCount += regions.length;
    const counts = Object.fromEntries(sections.map(s => [s, questions.filter(q => q.section === s).length]));
    console.log(`${source.id}: ${questions.length} questions ${JSON.stringify(counts)}; ` +
      `contexts ${JSON.stringify(countBy(contexts, 'kind'))}; skipped ${diagnostic.skipped.length} ` +
      `${JSON.stringify(countBy(diagnostic.skipped, 'reason'))}; ${bytes} bytes`);
    if (diagnostic.contextSkipped.length) console.log(`  Context skips: ${JSON.stringify(countBy(diagnostic.contextSkipped, 'reason'))}`);
  }
  // Publish the manifest only after all banks and every referenced image pass.
  for (const bank of banks) for (const item of [...bank.questions, ...bank.contexts]) {
    assert((await stat(join(output, bank.id, item.file))).isFile(), `Missing manifest file: ${bank.id}/${item.file}`);
  }
  const manifest = JSON.stringify({ banks }, null, 2) + '\n';
  await writeFile(join(output, 'manifest.json'), manifest);
  totalBytes += Buffer.byteLength(manifest);
  console.log(`Validated ${banks.length} banks, ${banks.reduce((n, b) => n + b.questions.length, 0)} questions, ` +
    `${imageCount} WebP images; ${totalBytes} total bytes including manifest. Output: ${output}`);
}

main().catch(error => { console.error(`build-banks: ${error.message}`); process.exitCode = 1; });
