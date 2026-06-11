// Capture screenshots from the live cockpit/copilot using Playwright (headless
// Chromium). The apps are real Svelte SPAs streaming a WebSocket, so we
// navigate to a deep-link URL, let the bus stream for a few seconds (so
// sparklines/rates fill in), then shoot.
//
// Driven by a MANIFEST file (default: shots.txt next to this script), one shot
// per line:  <url>  <output.png>  [preset]  [settleMs]
// See shots.txt for the format. Assumes the servers are already up (run.sh
// starts them: cockpit :5173, copilot :5174).
//
// Usage:
//   node capture.mjs                     # uses ./shots.txt
//   node capture.mjs path/to/other.txt   # a different manifest
import { chromium, devices } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, isAbsolute } from 'node:path';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');

const DSF = 2; // desktop retina

/** Resolve a preset name (or WxH) into Playwright context options. */
function presetToContext(preset) {
  const p = (preset ?? 'wide').toLowerCase();
  if (p === 'phone') return { ...devices['iPhone 13'] };
  if (p === 'wide') return { viewport: { width: 1440, height: 900 }, deviceScaleFactor: DSF };
  if (p === 'panel') return { viewport: { width: 1200, height: 800 }, deviceScaleFactor: DSF };
  const m = p.match(/^(\d+)x(\d+)$/); // custom "WxH" in CSS px
  if (m) return { viewport: { width: +m[1], height: +m[2] }, deviceScaleFactor: DSF };
  throw new Error(`unknown preset "${preset}" (use wide | panel | phone | <W>x<H>)`);
}

/** Parse the manifest file into [{url, output, preset, settleMs}]. */
function parseManifest(file) {
  const text = readFileSync(file, 'utf8');
  const shots = [];
  text.split('\n').forEach((line, i) => {
    const s = line.trim();
    if (!s || s.startsWith('#')) return;
    const [url, output, preset, settle] = s.split(/\s+/);
    if (!url || !output) throw new Error(`${file}:${i + 1}: need at least <url> <output.png>`);
    const out = isAbsolute(output) ? output : resolve(REPO_ROOT, output);
    shots.push({ url, output: out, preset, settleMs: settle ? +settle : 5000 });
  });
  return shots;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shoot(browser, shot) {
  const context = await browser.newContext(presetToContext(shot.preset));
  const page = await context.newPage();
  page.on('pageerror', (e) => console.warn(`  ⚠ page error: ${e.message}`));
  try {
    await mkdir(dirname(shot.output), { recursive: true });
    await page.goto(shot.url, { waitUntil: 'load', timeout: 30000 });
    await sleep(shot.settleMs); // WS keeps streaming; give the UI time to fill
    await page.screenshot({ path: shot.output }); // viewport shot (not fullPage)
    console.log(`  ✓ ${shot.output}`);
  } finally {
    await context.close();
  }
}

async function main() {
  const manifest = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : resolve(__dirname, 'shots.txt');
  const shots = parseManifest(manifest);
  console.log(`Capturing ${shots.length} shot(s) from ${manifest}`);
  const browser = await chromium.launch();
  const failed = [];
  try {
    for (const shot of shots) {
      console.log(`• ${shot.output.replace(REPO_ROOT + '/', '')}  ←  ${shot.url}`);
      try {
        await shoot(browser, shot); // one bad shot must not abort the rest
      } catch (e) {
        failed.push(shot.output);
        console.warn(`  ✗ ${e.message.split('\n')[0]}`);
      }
    }
  } finally {
    await browser.close();
  }
  if (failed.length) {
    console.error(`Done with ${failed.length} failure(s).`);
    process.exit(1);
  }
  console.log('Done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
