import { describe, it, expect } from "vitest";
import { renderPage, outputPathFor, ROOT_MARKER } from "./prerenderHtml.mjs";

const template = [
  "<!doctype html><html><head>",
  "<title>ZiptoGit - Home</title>",
  '<meta name="description" content="Home description" />',
  '<link rel="canonical" href="https://ziptogit.in/" />',
  '<meta property="og:url" content="https://ziptogit.in/" />',
  '<meta property="og:title" content="ZiptoGit - Home" />',
  '<meta property="og:description" content="Home description" />',
  '<meta name="twitter:title" content="ZiptoGit - Home" />',
  '<meta name="twitter:description" content="Home description" />',
  '<meta name="robots" content="index, follow" />',
  "</head><body>",
  ROOT_MARKER,
  '<script type="module" src="/assets/index.js"></script>',
  "</body></html>",
].join("\n");

const ORIGIN = "https://ziptogit.in";

describe("renderPage", () => {
  it("puts the app HTML in #root and records the route for hydration", () => {
    const html = renderPage(template, { path: "/faq" }, "<h1>FAQ</h1>", ORIGIN);
    expect(html).toContain('<div id="root" data-prerendered="/faq"><h1>FAQ</h1></div>');
    expect(html).not.toContain(ROOT_MARKER);
    expect(html).toContain('<script type="module" src="/assets/index.js"></script>');
    expect(html).not.toContain('application/ld+json');
  });

  it("gives a content page its own title, description, canonical and og:url", () => {
    const html = renderPage(
      template,
      { path: "/faq", title: "FAQ | ZiptoGit", description: "Questions & answers" },
      "<h1>x</h1>",
      ORIGIN
    );
    expect(html).toContain("<title>FAQ | ZiptoGit</title>");
    expect(html).toContain('<meta name="description" content="Questions &amp; answers" />');
    expect(html).toContain('<link rel="canonical" href="https://ziptogit.in/faq" />');
    expect(html).toContain('<meta property="og:url" content="https://ziptogit.in/faq" />');
    for (const attribute of ['property="og:title"', 'name="twitter:title"']) {
      expect(html).toContain(`<meta ${attribute} content="FAQ | ZiptoGit" />`);
    }
    for (const attribute of ['property="og:description"', 'name="twitter:description"']) {
      expect(html).toContain(`<meta ${attribute} content="Questions &amp; answers" />`);
    }
  });

  it("sets noindex on the prerendered error page", () => {
    const html = renderPage(template, { path: "/404", noindex: true }, "<h1>Page not found</h1>", ORIGIN);
    expect(html).toContain('<meta name="robots" content="noindex, follow" />');
  });

  it("leaves the home page's own title and description alone", () => {
    const html = renderPage(template, { path: "/" }, "<h1>Hero</h1>", ORIGIN);
    expect(html).toContain("<title>ZiptoGit - Home</title>");
    expect(html).toContain('content="Home description"');
    expect(html).toContain('<link rel="canonical" href="https://ziptogit.in/" />');
    expect(html).toContain('data-prerendered="/"');
  });

  it("declares the preferred site name on the homepage", () => {
    const html = renderPage(template, { path: "/" }, "<h1>Hero</h1>", ORIGIN);
    expect(html).toContain('<script id="website-schema" type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":"ZiptoGit","url":"https://ziptogit.in/"}</script>');
  });

  it("escapes quotes and angle brackets in attribute and title text", () => {
    const html = renderPage(
      template,
      { path: "/x", title: "A <b> & B", description: 'say "hi" <now>' },
      "<h1>x</h1>",
      ORIGIN
    );
    expect(html).toContain("<title>A &lt;b&gt; &amp; B</title>");
    expect(html).toContain('content="say &quot;hi&quot; &lt;now&gt;"');
  });

  it("does not interpret $ sequences in the app HTML or the text as replacement patterns", () => {
    const html = renderPage(template, { path: "/x", title: "Costs $& more" }, "<p>$1 and $&</p>", ORIGIN);
    expect(html).toContain("<p>$1 and $&</p>");
    expect(html).toContain("<title>Costs $&amp; more</title>");
  });

  it("fails loudly when the template has no, or more than one, #root", () => {
    expect(() => renderPage(template.replace(ROOT_MARKER, ""), { path: "/" }, "x", ORIGIN)).toThrow(/root/);
    expect(() => renderPage(template + ROOT_MARKER, { path: "/" }, "x", ORIGIN)).toThrow(/root/);
  });

  it("fails loudly when a tag it has to rewrite is missing, instead of shipping the home page's", () => {
    const noCanonical = template.replace(/<link rel="canonical"[^>]*>/, "");
    expect(() => renderPage(noCanonical, { path: "/faq" }, "x", ORIGIN)).toThrow(/canonical/);
    const noTitle = template.replace(/<title>[^<]*<\/title>/, "");
    expect(() => renderPage(noTitle, { path: "/faq", title: "FAQ | ZiptoGit" }, "x", ORIGIN)).toThrow(/title/);
  });
});

describe("outputPathFor", () => {
  it("maps / to index.html and other routes to <slug>/index.html", () => {
    expect(outputPathFor("/")).toBe("index.html");
    expect(outputPathFor("/faq")).toBe("faq/index.html");
    expect(outputPathFor("/404")).toBe("404.html");
    expect(outputPathFor("/how-it-works")).toBe("how-it-works/index.html");
  });

  it("refuses anything that is not a plain slug", () => {
    expect(() => outputPathFor("/../etc")).toThrow();
    expect(() => outputPathFor("/a/b")).toThrow();
  });
});
