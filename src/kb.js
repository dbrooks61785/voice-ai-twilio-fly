import fs from 'node:fs/promises';
import path from 'node:path';
import cheerio from 'cheerio';

const DEFAULT_EZ_BASE = 'https://ezlumperservices.com/';
const DEFAULT_HAULPASS_HOME = 'https://haulpass.ezlumperservices.com/';
const DEFAULT_INDEX_PATH = './data/kb_index.json';
const DEFAULT_EMBED_MODEL = 'text-embedding-3-small';
const DEFAULT_MAX_PAGES = 80;
const DEFAULT_MIN_CHARS = 300;
const DEFAULT_CHUNK_SIZE = 1200;
const DEFAULT_CHUNK_OVERLAP = 200;

const SKIP_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.css', '.js', '.json', '.xml', '.zip'
]);

const DEFAULT_USER_AGENT = 'EZLumperKB/1.0 (+https://ezlumperservices.com)';

function stripWww(hostname) {
  return hostname.startsWith('www.') ? hostname.slice(4) : hostname;
}

function normalizeUrl(rawUrl, preferredHost) {
  const url = new URL(rawUrl);
  const host = stripWww(url.hostname);
  if (preferredHost && (host === preferredHost || `www.${host}` === preferredHost)) {
    url.hostname = preferredHost;
  } else {
    url.hostname = host;
  }
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith('utm_')) {
      url.searchParams.delete(key);
    }
  }
  let normalized = url.toString();
  if (normalized.endsWith('/') && url.pathname !== '/') {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function isLikelyHtmlPath(url) {
  const pathname = url.pathname.toLowerCase();
  const extIndex = pathname.lastIndexOf('.');
  if (extIndex === -1) return true;
  const ext = pathname.slice(extIndex);
  return !SKIP_EXTENSIONS.has(ext);
}

function collapseWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function chunkText(text, chunkSize, overlap) {
  const chunks = [];
  if (!text) return chunks;
  const step = Math.max(1, chunkSize - overlap);
  for (let start = 0; start < text.length; start += step) {
    const end = Math.min(text.length, start + chunkSize);
    const chunk = text.slice(start, end).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    if (end >= text.length) break;
  }
  return chunks;
}

async function fetchHtml(url, userAgent) {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': userAgent
    },
    redirect: 'follow'
  });
  if (!resp.ok) return null;
  const contentType = resp.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return null;
  const html = await resp.text();
  return { html, finalUrl: resp.url };
}

function extractPage(html, baseUrl, allowedHosts) {
  const $ = cheerio.load(html);
  $('script, style, noscript, iframe').remove();
  const title = collapseWhitespace($('title').text()) || 'Untitled';
  const text = collapseWhitespace($('body').text());
  const links = new Set();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    try {
      const resolved = new URL(href, baseUrl);
      if (!isLikelyHtmlPath(resolved)) return;
      const host = stripWww(resolved.hostname);
      if (!allowedHosts.has(host)) return;
      links.add(resolved.toString());
    } catch {
      return;
    }
  });

  return { title, text, links: [...links] };
}

async function crawlSite({ baseUrl, maxPages, minChars, userAgent, log }) {
  const normalizedBase = normalizeUrl(baseUrl);
  const baseHost = stripWww(new URL(normalizedBase).hostname);
  const allowedHosts = new Set([baseHost, `www.${baseHost}`]);

  const queue = [normalizedBase];
  const visited = new Set();
  const pages = [];

  while (queue.length > 0 && pages.length < maxPages) {
    const current = queue.shift();
    const normalized = normalizeUrl(current, baseHost);
    if (visited.has(normalized)) continue;
    visited.add(normalized);

    let fetched;
    try {
      fetched = await fetchHtml(normalized, userAgent);
    } catch (err) {
      log?.warn({ url: normalized, err }, 'KB fetch failed');
      continue;
    }

    if (!fetched) continue;
    const { html, finalUrl } = fetched;
    const finalNormalized = normalizeUrl(finalUrl, baseHost);

    const { title, text, links } = extractPage(html, finalNormalized, allowedHosts);
    if (text.length >= minChars) {
      pages.push({ url: finalNormalized, title, text });
    }

    for (const link of links) {
      const normalizedLink = normalizeUrl(link, baseHost);
      if (!visited.has(normalizedLink)) {
        queue.push(normalizedLink);
      }
    }
  }

  return pages;
}

async function embedTexts(texts, apiKey, model) {
  const resp = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      input: texts
    })
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Embedding request failed (${resp.status}): ${body}`);
  }
  const data = await resp.json();
  return data.data.map((item) => item.embedding);
}

function normalizeVector(vec) {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum) || 1;
  return vec.map((v) => v / norm);
}

async function buildIndex({ pages, apiKey, model, chunkSize, chunkOverlap, log }) {
  const chunks = [];
  for (const page of pages) {
    const pageChunks = chunkText(page.text, chunkSize, chunkOverlap);
    for (const chunk of pageChunks) {
      chunks.push({
        id: `${page.url}#${chunks.length + 1}`,
        url: page.url,
        title: page.title,
        text: chunk
      });
    }
  }

  const embeddings = [];
  const batchSize = 64;
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const batchTexts = batch.map((c) => c.text);
    log?.info({ batch: i / batchSize + 1, total: Math.ceil(chunks.length / batchSize) }, 'KB embedding batch');
    const batchEmbeddings = await embedTexts(batchTexts, apiKey, model);
    embeddings.push(...batchEmbeddings);
  }

  const indexedChunks = chunks.map((chunk, index) => ({
    ...chunk,
    embedding: normalizeVector(embeddings[index])
  }));

  return indexedChunks;
}

async function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
}

export async function ingestKb({
  apiKey,
  embeddingModel = DEFAULT_EMBED_MODEL,
  indexPath = DEFAULT_INDEX_PATH,
  maxPages = DEFAULT_MAX_PAGES,
  minChars = DEFAULT_MIN_CHARS,
  chunkSize = DEFAULT_CHUNK_SIZE,
  chunkOverlap = DEFAULT_CHUNK_OVERLAP,
  ezBaseUrl = DEFAULT_EZ_BASE,
  haulpassHome = DEFAULT_HAULPASS_HOME,
  log
}) {
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for KB ingestion');
  }

  log?.info('KB ingestion started');
  const ezPages = await crawlSite({
    baseUrl: ezBaseUrl,
    maxPages,
    minChars,
    userAgent: DEFAULT_USER_AGENT,
    log
  });

  let haulpassPages = [];
  try {
    const fetched = await fetchHtml(haulpassHome, DEFAULT_USER_AGENT);
    if (fetched) {
      const { html, finalUrl } = fetched;
      const baseHost = stripWww(new URL(haulpassHome).hostname);
      const { title, text } = extractPage(html, finalUrl, new Set([baseHost, `www.${baseHost}`]));
      if (text.length >= minChars) {
        haulpassPages = [{ url: normalizeUrl(finalUrl, baseHost), title, text }];
      }
    }
  } catch (err) {
    log?.warn({ err }, 'Haulpass KB fetch failed');
  }

  const pages = [...ezPages, ...haulpassPages];
  const chunks = await buildIndex({
    pages,
    apiKey,
    model: embeddingModel,
    chunkSize,
    chunkOverlap,
    log
  });

  const payload = {
    createdAt: new Date().toISOString(),
    embeddingModel,
    sources: {
      ezBaseUrl,
      haulpassHome
    },
    chunkSize,
    chunkOverlap,
    chunks
  };

  const resolvedPath = path.resolve(indexPath);
  await ensureDir(resolvedPath);
  await fs.writeFile(resolvedPath, JSON.stringify(payload, null, 2), 'utf-8');
  log?.info({ chunks: chunks.length, path: resolvedPath }, 'KB ingestion complete');
  return payload;
}

export async function loadKbIndex(indexPath = DEFAULT_INDEX_PATH, log) {
  const resolvedPath = path.resolve(indexPath);
  try {
    const raw = await fs.readFile(resolvedPath, 'utf-8');
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.chunks)) {
      log?.warn({ path: resolvedPath }, 'KB index invalid');
      return null;
    }
    return data;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log?.warn({ err, path: resolvedPath }, 'KB index load failed');
    } else {
      log?.info({ path: resolvedPath }, 'KB index not found');
    }
    return null;
  }
}

export async function searchKb(index, query, { apiKey, model = DEFAULT_EMBED_MODEL, topK = 5, minScore = 0.72, log } = {}) {
  if (!index) {
    return { ok: false, reason: 'kb_not_ready', results: [] };
  }
  if (!query || !query.trim()) {
    return { ok: false, reason: 'empty_query', results: [] };
  }
  if (!apiKey) {
    return { ok: false, reason: 'missing_api_key', results: [] };
  }

  const [queryEmbedding] = await embedTexts([query], apiKey, model || index.embeddingModel || DEFAULT_EMBED_MODEL);
  const normalizedQuery = normalizeVector(queryEmbedding);

  const scored = index.chunks.map((chunk) => {
    let score = 0;
    for (let i = 0; i < normalizedQuery.length; i += 1) {
      score += normalizedQuery[i] * chunk.embedding[i];
    }
    return { ...chunk, score };
  });

  const results = scored
    .filter((item) => item.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((item) => ({
      score: Number(item.score.toFixed(4)),
      url: item.url,
      title: item.title,
      snippet: item.text.slice(0, 400)
    }));

  if (results.length === 0) {
    log?.info({ query }, 'KB search no results');
  }

  return { ok: true, results };
}
