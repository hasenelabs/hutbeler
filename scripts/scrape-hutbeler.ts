/**
 * Diyanet Hutbe Scraper
 *
 * Fetches Friday sermons (hutbeler) from the Diyanet website.
 * The data is embedded as SharePoint ListData JSON in the page HTML.
 * Supports pagination (30 items per page).
 *
 * Usage:
 *   node --experimental-strip-types scripts/scrape-hutbeler.ts
 *
 * No external dependencies required (uses built-in fetch).
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface Hutbe {
  id: number;
  date: string;
  title: string;
  pdf?: string;
  doc?: string;
  audio?: string;
  content?: string;
  source: string;
}

interface SPRow {
  ID: string;
  Tarih: string;
  Title: string;
  PDF?: string;
  'PDF.desc'?: string;
  Word?: string;
  Ses?: string;
}

const BASE_URL = 'https://dinhizmetleri.diyanet.gov.tr';
const START_URL = `${BASE_URL}/kategoriler/yayinlarimiz/hutbeler/t%C3%BCrk%C3%A7e`;
const OUTPUT_PATH = path.resolve(__dirname, '../hutbeler.json');

function resolveUrl(spPath: string): string {
  // SharePoint uses \u002f for /, decode it
  const decoded = spPath.replace(/\\u002f/g, '/');
  if (decoded.startsWith('http')) return decoded;
  return BASE_URL + (decoded.startsWith('/') ? '' : '/') + decoded;
}

/**
 * Normalize date from SharePoint format.
 * SP returns "6.03.2026" but we want "06.03.2026"
 */
function normalizeDate(dateStr: string): string {
  const parts = dateStr.split('.');
  if (parts.length !== 3) return dateStr;
  const [d, m, y] = parts;
  return `${d.padStart(2, '0')}.${m.padStart(2, '0')}.${y}`;
}

async function fetchPage(url: string): Promise<{ rows: SPRow[] }> {
  console.log('Fetching:', url);

  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
    },
  });

  if (!response.ok) {
    console.error(`HTTP ${response.status}: ${response.statusText}`);
    return { rows: [] };
  }

  const html = await response.text();
  console.log(`  Fetched ${html.length} bytes`);

  // Extract the WPQ1ListData JSON object
  const match = html.match(/WPQ1ListData\s*=\s*(\{[\s\S]*?\});\s*(?:var|<\/script>)/);
  if (!match) {
    // Save debug HTML for investigation
    const debugPath = path.resolve(__dirname, 'debug-page.html');
    fs.writeFileSync(debugPath, html, 'utf-8');
    console.warn('  Could not find WPQ1ListData (WAF block or different page structure).');
    console.warn('  Debug HTML saved to', debugPath);
    return { rows: [] };
  }

  let listData: { Row?: SPRow[] };
  try {
    listData = JSON.parse(match[1]);
  } catch (e) {
    console.error('  Failed to parse ListData JSON:', e);
    return { rows: [] };
  }

  const rows = listData.Row || [];
  console.log(`  Found ${rows.length} entries`);

  return { rows };
}

async function scrapeAll(): Promise<Hutbe[]> {
  const { rows: allRows } = await fetchPage(START_URL);
  console.log(`\nTotal scraped: ${allRows.length} entries`);

  // Convert SP rows to Hutbe objects
  const hutbeler: Hutbe[] = allRows.map((row) => ({
    id: 0, // Will be assigned later
    date: normalizeDate(row.Tarih),
    title: row.Title
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim(),
    pdf: row.PDF ? resolveUrl(row.PDF) : undefined,
    doc: row.Word ? resolveUrl(row.Word) : undefined,
    audio: row.Ses ? resolveUrl(row.Ses) : undefined,
    source: 'website',
  }));

  // Deduplicate by date+title
  const seen = new Set<string>();
  const deduped = hutbeler.filter((h) => {
    const key = `${h.date}|${h.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (deduped.length < hutbeler.length) {
    console.log(`Deduped: ${hutbeler.length} → ${deduped.length}`);
  }

  // Sort by date ascending (oldest first)
  deduped.sort((a, b) => {
    const [ad, am, ay] = a.date.split('.').map(Number);
    const [bd, bm, by] = b.date.split('.').map(Number);
    return new Date(ay, am - 1, ad).getTime() - new Date(by, bm - 1, bd).getTime();
  });

  // Assign IDs (oldest = 1, newest = highest)
  deduped.forEach((h, i) => { h.id = i + 1; });

  return deduped;
}

function merge(existing: Hutbe[], scraped: Hutbe[]): Hutbe[] {
  // Build a set of existing entries by date+title
  const existingKeys = new Set<string>();
  for (const h of existing) {
    existingKeys.add(`${h.date}|${h.title}`);
  }

  const merged = [...existing];
  for (const s of scraped) {
    const key = `${s.date}|${s.title}`;
    if (!existingKeys.has(key)) {
      merged.push(s);
      existingKeys.add(key);
      console.log(`  NEW: ${s.date} - ${s.title}`);
    }
  }

  // Sort by date descending (newest first)
  merged.sort((a, b) => {
    const [ad, am, ay] = a.date.split('.').map(Number);
    const [bd, bm, by] = b.date.split('.').map(Number);
    return new Date(by, bm - 1, bd).getTime() - new Date(ay, am - 1, ad).getTime();
  });

  // Reassign IDs: newest = highest
  merged.forEach((h, i) => { h.id = merged.length - i; });

  return merged;
}

async function main() {
  let existing: Hutbe[] = [];
  if (fs.existsSync(OUTPUT_PATH)) {
    existing = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf-8'));
    console.log(`Loaded ${existing.length} existing entries`);

    // Clean up garbage entries from previous broken scraper runs
    const before = existing.length;
    existing = existing.filter((h) => {
      if (h.title.length > 200) return false;
      if ((h.title.match(/\d{2}\.\d{2}\.\d{4}/g) || []).length > 1) return false;
      if (/^Sesli Hutbe$/i.test(h.title)) return false;
      if (/^TARİH/i.test(h.title)) return false;
      return true;
    });
    if (existing.length < before) {
      console.log(`Cleaned ${before - existing.length} garbage entries`);
    }
  }

  const scraped = await scrapeAll();
  if (scraped.length === 0) {
    console.log('No entries scraped. Check debug-page.html.');
    process.exit(1);
  }

  const merged = merge(existing, scraped);
  const newCount = merged.length - existing.length;
  console.log(`\nResult: ${merged.length} total, ${newCount} new`);

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(merged, null, 2), 'utf-8');
  console.log(`Written to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error('Scraper failed:', err);
  process.exit(1);
});
