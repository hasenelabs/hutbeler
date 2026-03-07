/**
 * Diyanet Hutbe Scraper
 *
 * Scrapes Friday sermons (hutbeler) from:
 *   https://dinhizmetleri.diyanet.gov.tr
 *
 * Merges new entries into src/assets/data/hutbeler.json.
 *
 * Usage:
 *   npx ts-node scripts/scrape-hutbeler.ts
 *
 * Requires: puppeteer (devDependency)
 */

import puppeteer from 'puppeteer';
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

const TARGET_URL =
  'https://dinhizmetleri.diyanet.gov.tr/kategoriler/yayinlarimiz/hutbeler/t%C3%BCrk%C3%A7e';
const OUTPUT_PATH = path.resolve(__dirname, '../hutbeler.json');

async function scrape(): Promise<Hutbe[]> {
  const browser = await puppeteer.launch({                                                                                                      
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],                                                                                         
  }); 
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  console.log('Navigating to:', TARGET_URL);
  await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60_000 });

  // Wait for SharePoint-rendered content
  await page.waitForSelector('.ms-listviewtable, .ms-vb2, table', { timeout: 30_000 }).catch(() => {
    console.warn('Could not find expected table selector, trying fallback...');
  });

  // Give extra time for SharePoint async render
  await new Promise((r) => setTimeout(r, 3000));

  const entries = await page.evaluate(() => {
    const results: Array<{
      date: string;
      title: string;
      pdf?: string;
      doc?: string;
      audio?: string;
    }> = [];

    // Try to find table rows with hutbe data
    const rows = document.querySelectorAll('tr');
    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      if (cells.length < 2) continue;

      const dateText = cells[0]?.textContent?.trim() ?? '';
      const titleText = cells[1]?.textContent?.trim() ?? '';

      // Skip header rows or empty rows
      if (!dateText || !titleText) continue;
      if (!/\d{2}\.\d{2}\.\d{4}/.test(dateText)) continue;

      const links = row.querySelectorAll('a[href]');
      let pdf: string | undefined;
      let doc: string | undefined;
      let audio: string | undefined;

      for (const link of links) {
        const href = (link as HTMLAnchorElement).href;
        if (href.endsWith('.pdf')) pdf = href;
        else if (href.endsWith('.doc') || href.endsWith('.docx')) doc = href;
        else if (href.endsWith('.mp3') || href.endsWith('.wav')) audio = href;
      }

      results.push({ date: dateText, title: titleText, pdf, doc, audio });
    }

    return results;
  });

  await browser.close();

  console.log(`Scraped ${entries.length} entries`);
  return entries.map((e, i) => ({
    id: i, // Temporary; will be reassigned during merge
    date: e.date,
    title: e.title,
    pdf: e.pdf,
    doc: e.doc,
    audio: e.audio,
    source: 'website',
  }));
}

function merge(existing: Hutbe[], scraped: Hutbe[]): Hutbe[] {
  const existingByTitle = new Map<string, Hutbe>();
  for (const h of existing) {
    existingByTitle.set(h.title, h);
  }

  let maxId = existing.reduce((max, h) => Math.max(max, h.id), 0);
  const merged = [...existing];

  for (const s of scraped) {
    if (!existingByTitle.has(s.title)) {
      maxId++;
      merged.push({
        ...s,
        id: maxId,
      });
      console.log(`  NEW: [${maxId}] ${s.date} - ${s.title}`);
    }
  }

  // Sort by id descending (newest first)
  merged.sort((a, b) => b.id - a.id);
  return merged;
}

async function main() {
  // Load existing data
  let existing: Hutbe[] = [];
  if (fs.existsSync(OUTPUT_PATH)) {
    existing = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf-8'));
    console.log(`Loaded ${existing.length} existing entries`);
  }

  // Scrape
  const scraped = await scrape();
  if (scraped.length === 0) {
    console.log('No entries scraped. SharePoint DOM may have changed.');
    process.exit(1);
  }

  // Merge
  const merged = merge(existing, scraped);
  const newCount = merged.length - existing.length;
  console.log(`Merged: ${merged.length} total, ${newCount} new`);

  // Write
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(merged, null, 2), 'utf-8');
  console.log(`Written to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error('Scraper failed:', err);
  process.exit(1);
});
