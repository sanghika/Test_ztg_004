import {StrictMode} from 'react';
import {createRoot, hydrateRoot} from 'react-dom/client';
import App from './App.tsx';
import {findPublicPage, NOT_FOUND_PAGE} from './routes';
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

// Reuse the prerendered markup when it belongs to the current route.
const page = findPublicPage(window.location.pathname) ?? NOT_FOUND_PAGE;
if (container.dataset.prerendered === page.path) {
  hydrateRoot(container, app);
} else {
  createRoot(container).render(app);
}
