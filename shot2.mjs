import { chromium } from "playwright";

const app = await chromium.launch();
const desktop = await app.newContext({ viewport: { width: 1440, height: 900 } });

for (const [name, path] of [["how-it-works", "/how-it-works"], ["privacy", "/privacy"], ["contact", "/contact"]]) {
  const page = await desktop.newPage();
  await page.goto(`http://localhost:3000${path}`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `/tmp/desktop_${name}.png`, fullPage: true });
  await page.close();
}

// Check focus-visible on the Connect GitHub button
const fpage = await desktop.newPage();
await fpage.goto("http://localhost:3000/", { waitUntil: "networkidle" });
await fpage.keyboard.press("Tab");
await fpage.keyboard.press("Tab");
await fpage.keyboard.press("Tab");
await fpage.keyboard.press("Tab");
await fpage.screenshot({ path: "/tmp/desktop_focus.png" });

await app.close();
console.log("done");
