// Dev-only: takes screenshots of the running app, for checking layout changes by eye.
//
//   npm run dev                       (or: npm run build && NODE_ENV=production npm start)
//   node scripts/screenshots.mjs [baseUrl]        default http://localhost:3000
//
// Writes PNGs to <os tmp dir>/ztg-shots (printed at the end): home and the content
// pages at desktop width, the home page at phone width, and the home page after
// four Tab presses (to see the keyboard focus ring).
//
// Playwright is NOT a dependency of this project: nothing at runtime or in the
// build uses it, and adding it would put a browser download into every `npm ci`.
// Install it for yourself when you want screenshots:
//   npm install --no-save playwright && npx playwright install chromium
import os from "node:os";
import path from "node:path";
import { mkdir } from "node:fs/promises";

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error(
    "Playwright is not installed. It is not a project dependency; install it for this run with:\n" +
      "  npm install --no-save playwright && npx playwright install chromium"
  );
  process.exit(1);
}

const baseUrl = (process.argv[2] || "http://localhost:3000").replace(/\/+$/, "");
const outDir = path.join(os.tmpdir(), "ztg-shots");
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch();
try {
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });

  const shoot = async (context, urlPath, file, { fullPage = true, before } = {}) => {
    const page = await context.newPage();
    await page.goto(`${baseUrl}${urlPath}`, { waitUntil: "networkidle" });
    if (before) await before(page);
    await page.screenshot({ path: path.join(outDir, file), fullPage });
    await page.close();
    console.log("wrote", file);
  };

  await shoot(desktop, "/", "desktop_home.png");
  for (const slug of ["how-it-works", "faq", "privacy", "terms", "contact"]) {
    await shoot(desktop, `/${slug}`, `desktop_${slug}.png`);
  }
  await shoot(phone, "/", "mobile_home.png");
  await shoot(desktop, "/", "desktop_focus.png", {
    fullPage: false,
    before: async (page) => {
      for (let i = 0; i < 4; i++) await page.keyboard.press("Tab");
    },
  });
} finally {
  await browser.close();
}
console.log(`done: ${outDir}`);
