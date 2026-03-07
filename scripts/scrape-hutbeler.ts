/**
 * Diyanet Hutbe Scraper
 *
 * Scrapes Friday sermons (hutbeler) from:
 *   https://dinhizmetleri.diyanet.gov.tr
 *
 * Merges new entries into hutbeler.json.
 *
 * Usage:
 *   npx ts-node scripts/scrape-hutbeler.ts
 *   npx ts-node scripts/scrape-hutbeler.ts --debug   (saves rendered HTML)
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
const DEBUG = process.argv.includes('--debug');

async function scrape(): Promise<Hutbe[]> {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  console.log('Navigating to:', TARGET_URL);
  await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60_000 });

  // Wait for SharePoint CSR to render — try multiple possible selectors
  const possibleSelectors = [
    '.ms-listviewtable',
    '.ms-vb2',
    '.ms-vb-title',
    'table.ms-listviewtable',
    '#onetidDoclibViewTbl0',
    '[id^="onetidDoclibViewTbl"]',
    '.ms-srch-item',
    '.dfwp-list',
    'table',
  ];

  let foundSelector = '';
  for (const sel of possibleSelectors) {
    try {
      await page.waitForSelector(sel, { timeout: 5_000 });
      foundSelector = sel;
      console.log(`Found selector: ${sel}`);
      break;
    } catch {
      // try next
    }
  }

  if (!foundSelector) {
    console.warn('No known selector found, will try generic extraction...');
  }

  // Extra wait for SharePoint async render
  await new Promise((r) => setTimeout(r, 5000));

  // Debug: save rendered HTML
  if (DEBUG) {
    const html = await page.content();
    const debugPath = path.resolve(__dirname, 'debug-page.html');
    fs.writeFileSync(debugPath, html, 'utf-8');
    console.log(`Debug HTML saved to ${debugPath}`);
  }

  const entries = await page.evaluate(() => {
    const results: Array<{
      date: string;
      title: string;
      pdf?: string;
      doc?: string;
      audio?: string;
    }> = [];

    // Strategy 1: SharePoint table rows (tr > td)
    const rows = document.querySelectorAll('tr');
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const cells = row.querySelectorAll('td');
      if (cells.length < 2) continue;

      // Look for a date pattern in any cell
      let dateText = '';
      let titleText = '';

      for (let j = 0; j < cells.length; j++) {
        const text = cells[j]?.textContent?.trim() ?? '';
        if (/^\d{2}\.\d{2}\.\d{4}$/.test(text) && !dateText) {
          dateText = text;
        } else if (text.length > 5 && !titleText && !/^\d{2}\.\d{2}\.\d{4}$/.test(text)) {
          titleText = text;
        }
      }

      if (!dateText || !titleText) continue;

      const links = row.querySelectorAll('a[href]');
      let pdf: string | undefined;
      let doc: string | undefined;
      let audio: string | undefined;

      for (let k = 0; k < links.length; k++) {
        const href = (links[k] as HTMLAnchorElement).href;
        const hrefLower = href.toLowerCase();
        if (hrefLower.includes('.pdf')) pdf = href;
        else if (hrefLower.includes('.doc')) doc = href;
        else if (hrefLower.includes('.mp3') || hrefLower.includes('.wav')) audio = href;
      }

      results.push({ date: dateText, title: titleText, pdf, doc, audio });
    }

    // Strategy 2: If no table rows found, try extracting from page text
    if (results.length === 0) {
      const bodyText = document.body.innerText;
      const datePattern = /(\d{2}\.\d{2}\.\d{4})/g;
      const allLinks = document.querySelectorAll('a[href]');

      // Group links by proximity to dates
      const linkMap = new Map<string, { pdf?: string; doc?: string; audio?: string }>();
      for (let i = 0; i < allLinks.length; i++) {
        const a = allLinks[i] as HTMLAnchorElement;
        const href = a.href.toLowerCase();
        if (href.includes('.pdf') || href.includes('.doc') || href.includes('.mp3')) {
          // Find the closest parent that might be a row
          let parent = a.closest('tr, div[class*="row"], div[class*="item"], li');
          if (parent) {
            const parentText = parent.textContent ?? '';
            const dateMatch = parentText.match(/\d{2}\.\d{2}\.\d{4}/);
            if (dateMatch) {
              const key = dateMatch[0];
              if (!linkMap.has(key)) linkMap.set(key, {});
              const links = linkMap.get(key)!;
              if (href.includes('.pdf')) links.pdf = a.href;
              else if (href.includes('.doc')) links.doc = a.href;
              else if (href.includes('.mp3')) links.audio = a.href;
            }
          }
        }
      }
    }

    return results;
  });

  // Debug: log page structure info
  if (DEBUG || entries.length === 0) {
    const debugInfo = await page.evaluate(() => {
      const tables = document.querySelectorAll('table');
      const trs = document.querySelectorAll('tr');
      const tds = document.querySelectorAll('td');
      const divItems = document.querySelectorAll('[class*="item"], [class*="list"], [class*="vb"]');

      // Get sample of visible text with dates
      const bodyText = document.body.innerText;
      const dateMatches = bodyText.match(/\d{2}\.\d{2}\.\d{4}/g) || [];

      // Get all unique class names on tables and their children
      const tableClasses: string[] = [];
      tables.forEach((t) => {
        if (t.className) tableClasses.push(`table.${t.className}`);
        t.querySelectorAll('[class]').forEach((el) => {
          if (el.className && typeof el.className === 'string') {
            tableClasses.push(el.tagName.toLowerCase() + '.' + el.className.split(' ').join('.'));
          }
        });
      });

      return {
        tables: tables.length,
        trs: trs.length,
        tds: tds.length,
        divItems: divItems.length,
        datesFound: dateMatches.slice(0, 5),
        sampleClasses: [...new Set(tableClasses)].slice(0, 20),
        bodyTextSample: bodyText.substring(0, 2000),
      };
    });

    console.log('\n=== DEBUG INFO ===');
    console.log('Tables:', debugInfo.tables);
    console.log('TRs:', debugInfo.trs);
    console.log('TDs:', debugInfo.tds);
    console.log('Div items:', debugInfo.divItems);
    console.log('Dates found in text:', debugInfo.datesFound);
    console.log('Sample classes:', debugInfo.sampleClasses.join('\n  '));
    console.log('\nBody text sample:\n', debugInfo.bodyTextSample);
    console.log('=================\n');
  }

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
    console.log('No entries scraped. Exiting without changes.');
    // Exit 0 so CI doesn't fail — no changes will be committed anyway
    process.exit(0);
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
