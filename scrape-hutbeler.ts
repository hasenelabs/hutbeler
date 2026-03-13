/**
 * Diyanet Hutbe Scraper
 *
 * Fetches Friday sermons (hutbeler) from the Diyanet website.
 * Uses plain HTTP fetch + HTML parsing (no browser needed).
 *
 * Usage:
 *   npx ts-node scripts/scrape-hutbeler.ts
 *
 * No external dependencies required (uses built-in fetch).
 */

import * as fs from 'fs';
import * as path from 'path';

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

const BASE_URL = 'https://dinhizmetleri.diyanet.gov.tr';
const TARGET_URL =
  `${BASE_URL}/kategoriler/yayinlarimiz/hutbeler/t%C3%BCrk%C3%A7e`;
const OUTPUT_PATH = path.resolve(__dirname, '../hutbeler.json');

function resolveUrl(href: string): string {
  if (href.startsWith('http')) return href;
  if (href.startsWith('/')) return BASE_URL + href;
  return BASE_URL + '/' + href;
}

/**
 * Derive a clean title from a PDF or DOC URL.
 * e.g. "Zekat%20ve%20F%C4%B1t%C4%B1r%20Sadakas%C4%B1.pdf" → "Zekat ve Fıtır Sadakası"
 */
function titleFromUrl(url: string): string {
  try {
    const fileName = decodeURIComponent(url.split('/').pop() || '');
    return fileName
      .replace(/\.pdf$|\.docx?$/i, '')
      .replace(/Sesli Hutbe\s*\(?\s*/i, '')
      .replace(/\)\s*$/, '')
      .trim();
  } catch {
    return '';
  }
}

/**
 * Strip all HTML tags and decode entities.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

async function scrape(): Promise<Hutbe[]> {
  console.log('Fetching:', TARGET_URL);

  const response = await fetch(TARGET_URL, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
    },
  });

  if (!response.ok) {
    console.error(`HTTP ${response.status}: ${response.statusText}`);
    return [];
  }

  const html = await response.text();
  console.log(`Fetched ${html.length} bytes`);

  // Save HTML for debugging
  const debugPath = path.resolve(__dirname, 'debug-page.html');
  fs.writeFileSync(debugPath, html, 'utf-8');
  console.log(`Debug HTML saved to ${debugPath}`);

  const results: Hutbe[] = [];

  // ── Strategy 1: SharePoint ListData JSON ──────────────────────
  const listDataMatch = html.match(/ListData"\s*:\s*(\{[\s\S]*?\})\s*[,;]/);
  if (listDataMatch) {
    try {
      const listData = JSON.parse(listDataMatch[1]);
      console.log('Found SharePoint ListData');
      if (listData.Row && Array.isArray(listData.Row)) {
        for (const row of listData.Row) {
          const date = row.Tarih || row.Date || '';
          const title = row.Title || row.FileLeafRef || '';
          if (date && title) {
            results.push({
              id: 0,
              date,
              title: title.replace(/\.pdf$|\.doc$|\.docx$/i, ''),
              pdf: row.FileRef?.endsWith('.pdf') ? resolveUrl(row.FileRef) : undefined,
              source: 'website',
            });
          }
        }
      }
    } catch (e) {
      console.warn('Failed to parse ListData:', e);
    }
  }

  // ── Strategy 2: Parse HTML table rows ─────────────────────────
  if (results.length === 0) {
    // Match individual <tr> rows. Use a non-greedy match that stops at
    // the NEXT </tr> to avoid grabbing nested/wrapper rows.
    const rowPattern = /<tr[^>]*?>([\s\S]*?)<\/tr>/gi;
    let m;

    while ((m = rowPattern.exec(html)) !== null) {
      const rowHtml = m[1];

      // Extract all <td> cells from this row
      const cellPattern = /<td[^>]*?>([\s\S]*?)<\/td>/gi;
      const cells: { text: string; html: string }[] = [];
      let cellMatch;
      while ((cellMatch = cellPattern.exec(rowHtml)) !== null) {
        cells.push({
          text: stripHtml(cellMatch[1]),
          html: cellMatch[1],
        });
      }

      if (cells.length < 2) continue;

      // ── Find the date cell (DD.MM.YYYY) ──
      let date = '';
      for (const cell of cells) {
        if (/^\d{2}\.\d{2}\.\d{4}$/.test(cell.text)) {
          date = cell.text;
          break;
        }
      }
      if (!date) continue;

      // ── Extract links from the entire row ──
      const linkPattern = /href="([^"]*?)"/gi;
      let pdf: string | undefined;
      let doc: string | undefined;
      let audio: string | undefined;
      let linkMatch;
      while ((linkMatch = linkPattern.exec(rowHtml)) !== null) {
        const href = linkMatch[1];
        const lower = href.toLowerCase();
        if (lower.endsWith('.pdf')) pdf = resolveUrl(href);
        else if (lower.endsWith('.doc') || lower.endsWith('.docx')) doc = resolveUrl(href);
        else if (lower.endsWith('.mp3') || lower.endsWith('.wav')) audio = resolveUrl(href);
      }

      // ── Determine the title ──
      // Candidate: first cell that is not a date and has reasonable length
      let title = '';
      for (const cell of cells) {
        const t = cell.text;
        if (
          t.length > 3 &&
          t.length < 200 &&
          !/^\d{2}\.\d{2}\.\d{4}$/.test(t) &&
          !/^Sesli Hutbe$/i.test(t) &&
          !/^PDF$/i.test(t) &&
          !/^WORD$/i.test(t) &&
          !/^MP3$/i.test(t) &&
          !/^TARİH/i.test(t) &&
          !/^BAŞLIK/i.test(t)
        ) {
          title = t;
          break;
        }
      }

      // Fallback: derive title from PDF or DOC filename
      if (!title && pdf) title = titleFromUrl(pdf);
      if (!title && doc) title = titleFromUrl(doc);
      if (!title && audio) title = titleFromUrl(audio);

      if (!title) continue;

      // Skip rows where the "title" contains multiple dates (it's a table header/wrapper)
      const dateCount = (title.match(/\d{2}\.\d{2}\.\d{4}/g) || []).length;
      if (dateCount > 1) {
        console.log(`  SKIP (multi-date garbage): ${title.substring(0, 60)}...`);
        continue;
      }

      results.push({ id: 0, date, title, pdf, doc, audio, source: 'website' });
    }
  }

  console.log(`Extracted ${results.length} entries`);

  // Deduplicate by date+title (same hutbe can appear in multiple rows)
  const seen = new Set<string>();
  const deduped: Hutbe[] = [];
  for (const h of results) {
    const key = `${h.date}|${h.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(h);
  }

  if (deduped.length < results.length) {
    console.log(`Deduped: ${results.length} → ${deduped.length}`);
  }

  // Sort by date ascending (oldest first) so IDs increase chronologically
  deduped.sort((a, b) => {
    const [ad, am, ay] = a.date.split('.').map(Number);
    const [bd, bm, by] = b.date.split('.').map(Number);
    const dateA = new Date(ay, am - 1, ad).getTime();
    const dateB = new Date(by, bm - 1, bd).getTime();
    return dateA - dateB;
  });

  return deduped;
}

function merge(existing: Hutbe[], scraped: Hutbe[]): Hutbe[] {
  // Index existing entries by date+title for dedup
  const existingKeys = new Set<string>();
  for (const h of existing) {
    existingKeys.add(`${h.date}|${h.title}`);
  }

  let maxId = existing.reduce((max, h) => Math.max(max, h.id), 0);
  const merged = [...existing];

  for (const s of scraped) {
    const key = `${s.date}|${s.title}`;
    if (!existingKeys.has(key)) {
      maxId++;
      merged.push({ ...s, id: maxId });
      existingKeys.add(key);
      console.log(`  NEW: [${maxId}] ${s.date} - ${s.title}`);
    }
  }

  // Sort by date descending (newest first), using date for ordering
  merged.sort((a, b) => {
    const [ad, am, ay] = a.date.split('.').map(Number);
    const [bd, bm, by] = b.date.split('.').map(Number);
    const dateA = new Date(ay, am - 1, ad).getTime();
    const dateB = new Date(by, bm - 1, bd).getTime();
    return dateB - dateA;
  });

  // Reassign IDs based on date order (newest = highest ID)
  for (let i = 0; i < merged.length; i++) {
    merged[i].id = merged.length - i;
  }

  return merged;
}

async function main() {
  let existing: Hutbe[] = [];
  if (fs.existsSync(OUTPUT_PATH)) {
    existing = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf-8'));
    console.log(`Loaded ${existing.length} existing entries`);

    // Clean up any garbage entries from previous broken scraper runs
    const cleanExisting = existing.filter((h) => {
      const dateCount = (h.title.match(/\d{2}\.\d{2}\.\d{4}/g) || []).length;
      if (dateCount > 1 || h.title.length > 200) {
        console.log(`  REMOVE garbage: [${h.id}] ${h.title.substring(0, 60)}...`);
        return false;
      }
      if (/^Sesli Hutbe$/i.test(h.title)) {
        console.log(`  REMOVE bad title: [${h.id}] "${h.title}"`);
        return false;
      }
      return true;
    });

    if (cleanExisting.length < existing.length) {
      console.log(`Cleaned: ${existing.length} → ${cleanExisting.length} entries`);
    }
    existing = cleanExisting;
  }

  const scraped = await scrape();
  if (scraped.length === 0) {
    console.log('No entries scraped. Check debug-page.html for page content.');
    process.exit(0);
  }

  const merged = merge(existing, scraped);
  const newCount = merged.length - existing.length;
  console.log(`Merged: ${merged.length} total, ${newCount} new`);

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(merged, null, 2), 'utf-8');
  console.log(`Written to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error('Scraper failed:', err);
  process.exit(1);
});
