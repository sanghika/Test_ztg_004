// Prerenders the home page and the content pages to static HTML.
//
//   vite build                                   -> dist/  (client bundle, empty #root)
//   vite build --ssr src/entry-server.tsx ...    -> dist-ssr/entry-server.js
//   node scripts/prerender.mjs                   -> this file
//
// Output in dist/:
//   index.html           "/"  with the signed-out hero already in the markup
//   <slug>/index.html    /how-it-works, /faq, /privacy, /terms, /contact
//   404.html             the prerendered page for unknown URLs
//   200.html             a copy of the Vite template for repeat builds
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
const { render, HOME_HEADING, PRERENDER_ROUTES, SITE_ORIGIN } = await import(pathToFileURL(entry).href);

// 200.html is the untouched Vite output. Reading it back when it exists makes
// running this script twice harmless.
const shellPath = path.join(distDir, "200.html");
const template = await readFile(existsSync(shellPath) ? shellPath : path.join(distDir, "index.html"), "utf8");
await writeFile(shellPath, template);

const manifest = JSON.parse(await readFile(path.join(distDir, ".vite", "manifest.json"), "utf8"));
const uploaderChunk = Object.values(manifest).find((chunk) => chunk.isDynamicEntry && chunk.name === "ZipUploader")?.file;
if (!uploaderChunk) throw new Error("prerender: homepage uploader chunk missing from the client manifest");
const homeTemplate = template.replace(
  "</head>",
  `<link rel="modulepreload" crossorigin href="/${uploaderChunk}" />\n  </head>`
);

for (const route of PRERENDER_ROUTES) {
  const appHtml = render(route.path);
  if (!appHtml.includes("<h1")) throw new Error(`prerender: ${route.path} rendered without an <h1>`);
  // The whole point of the home page's prerender is that the hero is in the HTML.
  if (route.path === "/" && !appHtml.includes(HOME_HEADING)) {
    throw new Error("prerender: the signed-out hero is missing from the prerendered home page");
  }
  const out = path.join(distDir, outputPathFor(route.path));
  await mkdir(path.dirname(out), { recursive: true });
  const pageTemplate = route.path === "/" ? homeTemplate : template;
  await writeFile(out, renderPage(pageTemplate, route, appHtml, SITE_ORIGIN));
  console.log(`prerendered ${route.path.padEnd(16)} -> ${path.relative(process.cwd(), out)}`);
}
