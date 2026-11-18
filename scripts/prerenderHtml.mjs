// Pure string work for the prerender step, kept apart from scripts/prerender.mjs
// (file system + SSR bundle) so it can be unit tested on its own.

const escapeAttr = (value) =>
  String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeText = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Replaces exactly one match and throws if there is none. A template that
// drifted (someone reworded a tag in index.html) must fail the build, not
// quietly ship a page whose <title> or canonical is still the home page's.
function replaceOnce(html, pattern, replacer, label) {
  if (!pattern.test(html)) throw new Error(`prerender: could not find ${label} in the HTML template`);
  return html.replace(pattern, replacer);
}

export const ROOT_MARKER = '<div id="root"></div>';

/**
 * @param {string} template  dist/index.html as Vite wrote it (empty #root)
 * @param {{path: string, title?: string, description?: string, noindex?: boolean}} route
 * @param {string} appHtml   output of render(route.path)
 * @param {string} origin    e.g. https://ziptogit.in (no trailing slash)
 */
export function renderPage(template, route, appHtml, origin) {
  if (template.split(ROOT_MARKER).length !== 2) {
    throw new Error(`prerender: expected exactly one ${ROOT_MARKER} in the HTML template`);
  }
  // data-prerendered tells src/main.tsx this markup is for this exact route,
  // so it hydrates instead of rendering from scratch.
  let html = template.replace(
    ROOT_MARKER,
    () => `<div id="root" data-prerendered="${escapeAttr(route.path)}">${appHtml}</div>`
  );

  const url = origin + route.path;
  const setAttribute = (pattern, value, label) => {
    html = replaceOnce(html, pattern, (_, a, b) => a + escapeAttr(value) + b, label);
  };
  setAttribute(/(<link rel="canonical" href=")[^"]*(")/, url, "the canonical link");
  setAttribute(/(<meta property="og:url" content=")[^"]*(")/, url, "og:url");
  if (route.title) {
    html = replaceOnce(html, /<title>[^<]*<\/title>/, () => `<title>${escapeText(route.title)}</title>`, "the <title>");
    setAttribute(/(<meta property="og:title" content=")[^"]*(")/, route.title, "og:title");
    setAttribute(/(<meta name="twitter:title" content=")[^"]*(")/, route.title, "twitter:title");
  }
  if (route.description) {
    setAttribute(/(<meta name="description" content=")[^"]*(")/, route.description, "the meta description");
    setAttribute(/(<meta property="og:description" content=")[^"]*(")/, route.description, "og:description");
    setAttribute(/(<meta name="twitter:description" content=")[^"]*(")/, route.description, "twitter:description");
  }
  if (route.noindex) {
    setAttribute(/(<meta name="robots" content=")[^"]*(")/, "noindex, follow", "robots");
  }
  return html;
}

/** Where a route's HTML goes inside dist/: "/" -> index.html, "/faq" -> faq/index.html. */
export function outputPathFor(routePath) {
  if (routePath === "/") return "index.html";
  if (routePath === "/404") return "404.html";
  const slug = routePath.replace(/^\/+|\/+$/g, "");
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`prerender: unsupported route path ${routePath}`);
  return `${slug}/index.html`;
}
