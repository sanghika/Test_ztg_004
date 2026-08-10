import { chromium } from "playwright";

const app = await chromium.launch();
const desktop = await app.newContext({ viewport: { width: 1440, height: 900 } });
const dpage = await desktop.newPage();
await dpage.goto("http://localhost:3000/", { waitUntil: "networkidle" });
await dpage.screenshot({ path: "/tmp/desktop_home.png", fullPage: true });

const mobile = await app.newContext({ viewport: { width: 390, height: 844 } });
const mpage = await mobile.newPage();
await mpage.goto("http://localhost:3000/", { waitUntil: "networkidle" });
await mpage.screenshot({ path: "/tmp/mobile_home.png", fullPage: true });

await app.close();
console.log("done");
