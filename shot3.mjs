import { chromium } from "playwright";
const app = await chromium.launch();
const desktop = await app.newContext({ viewport: { width: 1440, height: 900 } });
const page = await desktop.newPage();
await page.goto("http://localhost:3000/contact", { waitUntil: "networkidle" });
await page.screenshot({ path: "/tmp/desktop_contact_fixed.png", fullPage: true });
await app.close();
console.log("done");
