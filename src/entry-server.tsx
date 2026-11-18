// Server-side entry, used only at build time by scripts/prerender.mjs
// (`vite build --ssr`). Never shipped to the browser.
import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router-dom";
import { AppRoutes } from "./App.tsx";

export { PRERENDER_ROUTES, SITE_ORIGIN } from "./routes.ts";

/** HTML for the app at `url`, to go inside <div id="root">. */
export function render(url: string): string {
  return renderToString(
    <StaticRouter location={url}>
      <AppRoutes />
    </StaticRouter>,
  );
}
