// Weekly health check for Daily Beauty.
// Tests every data source the cards depend on, every curated Wikipedia entry
// (and the image the page would show for it), and every fixed link on the page.
// Exits 1 when something is definitely broken; writes report.md either way.

import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const UA = 'DailyBeautyHealthCheck/1.0 (+https://github.com/toddstevensdce-oss/daily-beauty)';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const failures = [];  // definitely broken: the page will show an error or a dead link
const warnings = [];  // could not confirm: rate limits, bot blocks, transient errors
let passed = 0;
const fail = (area, msg) => failures.push(`**${area}**: ${msg}`);
const warn = (area, msg) => warnings.push(`**${area}**: ${msg}`);
const ok = () => passed++;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// retries when a server says it's busy (429/503), honoring Retry-After
async function get(url, { ua = UA, method = 'GET' } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      const r = await fetch(url, { method, headers: { 'User-Agent': ua, Accept: '*/*' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
      res = { status: r.status, r };
    } catch (e) {
      res = { status: 0, error: e.cause?.code || e.name || e.message };
    }
    if (![429, 503].includes(res.status) || attempt === 3) return res;
    const after = Number(res.r?.headers.get('retry-after'));
    await sleep(Math.min(30, after > 0 ? after : 2 ** (attempt + 1)) * 1000);
  }
}
async function json(url) {
  const res = await get(url);
  if (res.status !== 200) return { ...res, data: null };
  try { return { ...res, data: await res.r.json() }; } catch { return { ...res, status: -1, data: null }; }
}
// run tasks a few at a time to stay polite to the APIs
async function pool(items, size, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: size }, async () => { while (queue.length) await fn(queue.shift()); }));
}

// ---------- live data sources ----------
async function checkSources() {
  // Art Institute of Chicago: only the first 1,000 results are served (pages 1-100 at limit 10)
  const aic = 'https://api.artic.edu/api/v1/artworks/search?query[term][is_public_domain]=true&fields=id,title,image_id&limit=10&page=';
  for (const p of [1, 100]) {
    const { status, data } = await json(aic + p);
    if (status !== 200) fail('Artwork (Art Institute)', `search page ${p} returned HTTP ${status}. The card falls back to The Met.`);
    else if (!data.data?.some(x => x.image_id)) fail('Artwork (Art Institute)', `search page ${p} returned no artworks with images.`);
    else {
      ok();
      if (p === 1) {
        const id = data.data.find(x => x.image_id).image_id;
        const img = await get(`https://www.artic.edu/iiif/2/${id}/full/843,/0/default.jpg`, { ua: BROWSER_UA });
        img.status === 200 ? ok() : warn('Artwork (Art Institute)', `artwork image returned HTTP ${img.status}.`);
      }
    }
  }

  // The Met (artwork fallback)
  const met = 'https://collectionapi.metmuseum.org/public/collection/v1.1/search?isHighlight=true&hasImages=true&q=painting';
  const head = await json(met + '&offset=0&limit=1');
  if (head.status !== 200 || !head.data?.total) fail('Artwork (The Met)', `search returned HTTP ${head.status}${head.data ? ' with no results' : ''}. The backup source is down.`);
  else {
    const page = await json(`${met}&offset=${Math.max(0, head.data.total - 10)}&limit=10`);
    const ids = page.data?.objectIDs || [];
    let found = false;
    for (const id of ids.slice(0, 5)) {
      const o = await json(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`);
      if (o.data?.primaryImageSmall) { found = true; break; }
    }
    found ? ok() : fail('Artwork (The Met)', 'search worked but no object came back with an image.');
  }

  // NASA APOD: the shared DEMO_KEY is often rate-limited; the card has a curated fallback
  const apod = await get('https://api.nasa.gov/planetary/apod?api_key=DEMO_KEY&thumbs=true');
  if (apod.status === 200) ok();
  else warn('Nature (NASA)', `APOD returned ${apod.status ? 'HTTP ' + apod.status : apod.error}. The card shows its curated nature fallback when this happens.`);

  // Wikimedia featured feed: photo of the day + featured article
  const d = new Date();
  const ymd = [d.getUTCFullYear(), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0')].join('/');
  const feed = await json(`https://api.wikimedia.org/feed/v1/wikipedia/en/featured/${ymd}`);
  if (feed.status !== 200) fail('Photo + Featured Writing (Wikimedia)', `featured feed returned HTTP ${feed.status}.`);
  else {
    feed.data.image ? ok() : warn('Photograph of the Day', 'feed has no featured image today.');
    feed.data.tfa ? ok() : warn('Featured Writing', 'feed has no featured article today.');
  }

  // PoetryDB
  const poem = await json('https://poetrydb.org/random/1');
  poem.status === 200 && poem.data?.[0]?.lines?.length ? ok() : fail('Poem (PoetryDB)', `random poem returned HTTP ${poem.status}.`);
}

// ---------- curated Wikipedia entries (music, crafts, architecture, colors, ideas, birds, theologians, nature) ----------
async function checkWikipedia() {
  const titles = [...new Set([...html.matchAll(/\bw:"([^"]+)"/g)].map(m => m[1]))];
  // one at a time with a short pause: Wikipedia rate-limits bursts from a single client
  await pool(titles, 1, async (t) => {
    await sleep(300);
    const { status, data } = await json('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(t.replace(/ /g, '_')));
    if (status === 429 || status === 503 || status === 0) return warn('Wikipedia entry', `"${t}" could not be checked (${status ? 'HTTP ' + status : 'network error'}).`);
    if (status !== 200) return fail('Wikipedia entry', `"${t}" returned HTTP ${status}. Its card will show no summary or image.`);
    if (data.type === 'disambiguation') return fail('Wikipedia entry', `"${t}" is now a disambiguation page.`);
    if (!data.extract) warn('Wikipedia entry', `"${t}" has no summary text.`);
    ok();
    if (data.thumbnail) {
      // mirror wikiSummary(): Wikimedia only serves certain pre-rendered widths
      const w = data.originalimage?.width || 0;
      const src = w >= 960 ? data.thumbnail.source.replace(/\/\d+px-/, '/960px-')
                : w >= 500 ? data.thumbnail.source.replace(/\/\d+px-/, '/500px-')
                : data.thumbnail.source;
      const img = await get(src, { method: 'HEAD' });
      if (img.status === 200) ok();
      else if (img.status === 429) warn('Wikipedia image', `"${t}" image rate-limited during the check.`);
      else fail('Wikipedia image', `"${t}" image returned HTTP ${img.status}: ${src}`);
    }
  });
  return titles.length;
}

// ---------- fixed links on the page ----------
async function checkLinks() {
  const urls = new Set();
  for (const m of html.matchAll(/href="(https:[^"]+)"/g)) urls.add(m[1]);
  for (const m of html.matchAll(/\b[ur]:['"](https:[^'"]+)['"](?!\s*\+)/g)) urls.add(m[1]);
  // the pattern above already skips partial URLs the page completes in code ('...?s=' + name);
  // also skip font hosts and the page's own address
  const links = [...urls].filter(u => !/fonts\.(googleapis|gstatic)\.com|toddstevensdce-oss\.github\.io/.test(u));
  await pool(links, 4, async (u) => {
    let res = await get(u, { ua: BROWSER_UA });
    if (res.status === 405) res = await get(u, { ua: BROWSER_UA });
    const s = res.status;
    if (s >= 200 && s < 400) ok();
    else if (s === 404 || s === 410) fail('Link', `${u} is gone (HTTP ${s}).`);
    else if (s === 0 && /ENOTFOUND|EAI_AGAIN/.test(res.error)) fail('Link', `${u}: the domain no longer resolves.`);
    else if (s === 403 || s === 429 || s === 401) warn('Link', `${u} blocks automated checks (HTTP ${s}). Open it by hand to confirm.`);
    else warn('Link', `${u} returned ${s ? 'HTTP ' + s : res.error}. Possibly temporary.`);
  });
  return links.length;
}

// ---------- run ----------
await checkSources();
const nTitles = await checkWikipedia();
const nLinks = await checkLinks();

const date = new Date().toISOString().slice(0, 10);
const lines = [
  `# Daily Beauty health check: ${date}`,
  '',
  failures.length ? `**${failures.length} problem(s) found.**` : '**Everything checked is working.**',
  '',
  `Checked the live data sources, ${nTitles} curated Wikipedia entries and their images, and ${nLinks} fixed links. ${passed} checks passed.`,
  '',
];
if (failures.length) lines.push('## Broken', '', ...failures.map(f => '- ' + f), '');
if (warnings.length) lines.push('## Could not confirm', '', 'These are usually rate limits or sites that block automated visitors, not real breakage.', '', ...warnings.map(w => '- ' + w), '');
const report = lines.join('\n');

writeFileSync('report.md', report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
console.log(report);
process.exit(failures.length ? 1 : 0);
