# Matchframe Esports logos

Masters (transparent PNG, trimmed):

| File | What | Used for |
|---|---|---|
| `matchframe-mark.png` | The mark on its own | Program top bar, website header and footer, Windows icon, favicons |
| `matchframe-badge.png` | Hexagon badge with the name | Program sign-in and connection screens |
| `matchframe-lockup.png` | Mark with "MatchFrame Esports" beside it | Social preview image, wide placements |

The logos have transparent backgrounds and are designed for dark backgrounds (the white letters have a dark outline, so they also work on light ones).

Sized copies in the apps:

- `apps/desktop/build/icon.ico` (16–256 px) and `icon.png` (512 px): the program's Windows and Linux icon, used for the `.exe`, installer, shortcuts and window.
- `apps/operator-web/src/assets/mark.webp` (128 px) and `badge.webp` (480 px): the program's console.
- `apps/cloud-web/public/brand/` (`mark.webp`, `badge.webp`, `lockup.webp`/`.png`, `og-image.png` 1200×630), plus `favicon.ico`, `favicon-32.png`, `favicon-192.png` and `apple-touch-icon.png` in `apps/cloud-web/public/`.

Regenerate the sized copies from the masters when the logo changes (resize with a high-quality filter; keep the transparency, except for `apple-touch-icon.png` and `og-image.png`, which sit on the badge's navy `#0a0f1c`).
