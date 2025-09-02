# Chrome Extension (Popup-only) — React + Vite

Beginner-friendly Chrome Extension using React + Vite (Manifest V3), simplified to a single popup page.

## Get Started

- Install deps:
  ```bash
  npm install
  ```
- Build (writes to `dist/`):
  ```bash
  npm run build
  ```
- Watch (rebuild on change):
  ```bash
  npm run watch
  ```

Load in Chrome:
- Open `chrome://extensions`
- Enable Developer mode
- Click "Load unpacked" and choose the `dist/` folder

## Structure

- `public/manifest.json` — Manifest V3. Popup points to `index.html`.
- `index.html` — Root HTML (Vite-style). Loads `src/main.jsx`.
- `src/main.jsx` — React entry. Mounts `App` into `#root`.
- `src/App.jsx` — Your popup UI component.
- `src/components/` — For shared React components (empty for now).
- `src/elements/` — For small UI elements (empty for now).
- `src/styles/` — SCSS: `_variables.scss`, `_mixins.scss`, `base.scss`, `popup.scss`.

## Notes

- Icons: add PNG icons in `public/icons/` and reference them in the manifest if needed.
- Keep it simple: edit `src/App.jsx` to build your popup UI.
