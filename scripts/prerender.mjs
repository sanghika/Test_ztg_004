// Prerenders the home page and the content pages to static HTML.
//
//   vite build                                   -> dist/  (client bundle, empty #root)
//   vite build --ssr src/entry-server.tsx ...    -> dist-ssr/entry-server.js
//   node scripts/prerender.mjs                   -> this file
//
// Output in dist/:
//   index.html           "/"  with the signed-out hero already in the markup
//   <slug>/index.html    /how-it-works, /faq, /privacy, /terms, /contact
//   200.html             the original empty-#root page, for any other URL
//
// The h1 that is the page's LCP element is therefore in the HTML itself and
// paints as soon as the CSS arrives, without waiting for JS or /api/me.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { renderPage, outputPathFor } from "./prerenderHtml.mjs";

const distDir = path.join(process.cwd(), "dist");
const ssrDir = path.join(process.cwd(), "dist-ssr");

const entry = ["entry-server.js", "entry-server.mjs"].map((f) => path.join(ssrDir, f)).find((f) => existsSync(f));
if (!entry) throw new Error("prerender: dist-ssr/entry-server.js not found. Run `npm run build:ssr` first.");
const { render, PRERENDER_ROUTES, SITE_ORIGIN } = await import(pathToFileURL(entry).href);

// 200.html is the untouched Vite output. Reading it back when it exists makes
// running this script twice harmless.
const shellPath = path.join(distDir, "200.html");
const template = await readFile(existsSync(shellPath) ? shellPath : path.join(distDir, "index.html"), "utf8");
await writeFile(shellPath, template);

for (const route of PRERENDER_ROUTES) {
  const appHtml = render(route.path);
  if (!appHtml.includes("<h1")) throw new Error(`prerender: ${route.path} rendered without an <h1>`);
  // The whole point of the home page's prerender is that the hero is in the HTML.
  if (route.path === "/" && !appHtml.includes("Connect your GitHub account")) {
    throw new Error("prerender: the signed-out hero is missing from the prerendered home page");
  }
  const out = path.join(distDir, outputPathFor(route.path));
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, renderPage(template, route, appHtml, SITE_ORIGIN));
  console.log(`prerendered ${route.path.padEnd(16)} -> ${path.relative(process.cwd(), out)}`);
}
console.log("wrote dist/200.html (empty shell for other URLs)");
