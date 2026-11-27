// Regenerates the PNG app icons from the brand mark. Run rarely (the icons are committed):
//   node scripts/generate-icons.mjs        # needs the Playwright devDependency and a Chromium (npx playwright install chromium)
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const out = fileURLToPath(new URL('../public/icons/', import.meta.url));
mkdirSync(out, { recursive: true });

const mark = `
  <circle cx="64" cy="64" r="44" fill="#f4f0e8"/>
  <text x="64" y="78" text-anchor="middle" font-family="monospace" font-size="38" font-weight="700" fill="#0a0b0d" letter-spacing="2">CV</text>`;
const rounded = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="28" fill="#07080a"/>${mark}</svg>`;
// Full-bleed: the OS applies its own mask (Android maskable, iOS home screen). The mark already sits
// inside the 80% safe zone (radius 44 of 128 = 34% < 40%).
const bleed = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" fill="#07080a"/>${mark}</svg>`;

const icons = [
  ['icon-192.png', 192, rounded, true],
  ['icon-512.png', 512, rounded, true],
  ['icon-maskable-512.png', 512, bleed, false],
  ['apple-touch-icon.png', 180, bleed, false],
];

const browser = await chromium.launch(
  process.env.E2E_CHROMIUM_PATH ? { executablePath: process.env.E2E_CHROMIUM_PATH } : {},
);
const page = await browser.newPage();
for (const [name, size, svg, transparent] of icons) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
  );
  writeFileSync(`${out}${name}`, await page.screenshot({ omitBackground: transparent }));
}
await browser.close();
