/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** GA4 measurement ID (G-XXXXXXXXXX), read at build time. Unset means no analytics. */
  readonly VITE_GA_MEASUREMENT_ID?: string;
}
