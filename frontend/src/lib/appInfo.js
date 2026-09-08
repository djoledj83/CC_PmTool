// Single source of truth for the app's identity shown in the UI (the
// sidebar footer, Help → About, browser tab title, etc.).
//
// PER-CUSTOMER BRANDING — do NOT hardcode a customer name here. Set these
// in the root `.env` (they are baked into the bundle at build time by
// docker-compose.yml → Dockerfile.prod → Vite):
//
//   VITE_APP_NAME          product name shown everywhere in the UI
//   VITE_COPYRIGHT_HOLDER  legal entity in the © line
//
// Keep VITE_APP_NAME in sync with the backend's APP_NAME (used in emails
// and Excel exports) — docker-compose.yml wires both from the same
// APP_NAME value in the root .env. See TEMPLATE_SETUP.md.
//
// Versioning: semantic versioning — MAJOR.MINOR.PATCH.
//   MAJOR — breaking changes / big milestones
//   MINOR — new, backwards-compatible features
//   PATCH — backwards-compatible fixes
// On each release bump APP_VERSION here and keep it in sync with the
// `version` field in frontend/package.json and backend/package.json.
export const APP_NAME = import.meta.env.VITE_APP_NAME || 'PM Tool';
export const APP_VERSION = '1.0.0';
export const COPYRIGHT_YEAR = new Date().getFullYear();
export const COPYRIGHT_HOLDER =
    import.meta.env.VITE_COPYRIGHT_HOLDER || 'Your Company';
export const APP_COPYRIGHT = `© ${COPYRIGHT_YEAR} ${COPYRIGHT_HOLDER}. All rights reserved.`;
