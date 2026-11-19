export const WEBSITE_SCHEMA_ID = "website-schema";

/** @param {string} origin */
export function websiteStructuredData(origin) {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "ZiptoGit",
    url: origin + "/",
  }).replace(/</g, "\\u003c");
}
