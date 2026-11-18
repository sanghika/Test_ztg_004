import {StrictMode} from 'react';
import {createRoot, hydrateRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { reportWebVitals } from './lib/reportWebVitals';

// A failed analytics download must not interfere with rendering.
void reportWebVitals().catch(() => {});

const container = document.getElementById('root')!;
const app = (
  <StrictMode>
    <App />
  </StrictMode>
);

// `npm run build` prerenders each page into static HTML and stamps the route on
// #root (data-prerendered). When that is the page we are on, attach React to
// the existing markup instead of rebuilding it, so the h1 that already painted
// is the same DOM node afterwards. Anywhere else (dev server, an unknown URL
// served the empty shell) there is nothing to attach to and React renders from
// scratch. Comparing the route, not just checking for children, means a
// prerendered page that ends up at a different URL is never hydrated wrongly.
const normalize = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
if (container.dataset.prerendered === normalize(window.location.pathname)) {
  hydrateRoot(container, app);
} else {
  createRoot(container).render(app);
}
