// Builds every GridQ brand asset from the authorised logo (assets/brand/gridq-logo-source.jpeg,
// navy + teal on white). Re-run after replacing the source:  node scripts/build-brand-assets.mjs
//
//   assets/logo.png                         full logo (emblem + wordmark), transparent background
//   assets/gridq-emblem.png                 emblem only, transparent (input for build-app-icons.mjs)
//   frontend/public/gridq-mark.png          emblem for dark UI: transparent, navy shown white, teal kept
//   infra/keycloak-theme/.../gridq-mark.png same, for the sign-in page
//   {,frontend/,mobile-native-fixed/}public/favicon.svg   emblem badge (PWA/browser icon)
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'assets', 'brand', 'gridq-logo-source.jpeg');

// White -> transparent: alpha from "distance to white", colour un-premultiplied so edges stay clean.
async function knockOutWhite(input) {
  const { data, info } = await sharp(input).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(info.width * info.height * 4);
  for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const a = Math.min(255, Math.max(0, (255 - Math.min(r, g, b)) * 1.25));
    const k = a / 255;
    const un = (c) => (k > 0.02 ? Math.max(0, Math.min(255, Math.round((c - 255 * (1 - k)) / k))) : 0);
    out[j] = un(r); out[j + 1] = un(g); out[j + 2] = un(b); out[j + 3] = a < 8 ? 0 : a;
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

const full = await knockOutWhite(src);

// The wordmark sits below the emblem; the gap between them is the first fully empty row band
// below the emblem's baseline bar (found by scanning, not hard-coded).
const { data: a, info } = await sharp(full).raw().toBuffer({ resolveWithObject: true });
const rowHasInk = (y) => { for (let x = 0; x < info.width; x++) if (a[(y * info.width + x) * 4 + 3] > 40) return true; return false; };
let y = info.height - 1;
while (y > 0 && !rowHasInk(y)) y--;                    // bottom margin
while (y > 0 && rowHasInk(y)) y--;                     // up through the wordmark
const splitY = y;

await sharp(full).trim({ threshold: 1 }).png({ compressionLevel: 9 }).toFile(join(root, 'assets', 'logo.png'));
// extract and trim in separate pipelines: sharp would otherwise trim first and the extract box no longer fits
const top = await sharp(full).extract({ left: 0, top: 0, width: info.width, height: splitY }).png().toBuffer();
const emblem = await sharp(top).trim({ threshold: 1 }).png().toBuffer();
await sharp(emblem).png({ compressionLevel: 9 }).toFile(join(root, 'assets', 'gridq-emblem.png'));

async function badge(size, file) {
  const inner = Math.round(size * 0.74);
  const e = await sharp(emblem).resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  const disc = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`);
  const out = sharp(disc).composite([{ input: e, gravity: 'center' }]).png({ compressionLevel: 9 });
  return file ? out.toFile(file) : out.toBuffer();
}
// On-dark (reversed) emblem, transparent: navy parts become white so they read on the navy UI,
// the teal ring stays teal. Teal pixels are the ones where green clearly beats red.
async function onDark(size, file) {
  const { data, info } = await sharp(emblem).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] && data[i + 1] - data[i] < 50) data[i] = data[i + 1] = data[i + 2] = 255;
  }
  await sharp(data, { raw: info }).png({ compressionLevel: 9 }).toFile(file);
}
await onDark(512, join(root, 'frontend', 'public', 'gridq-mark.png'));
await onDark(512, join(root, 'infra', 'keycloak-theme', 'gridq', 'login', 'resources', 'img', 'gridq-mark.png'));
// favicon.svg (PWA icon in vite.config.js) wraps the 192px badge so the existing references keep working
const fav = await badge(192);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><image width="192" height="192" href="data:image/png;base64,${fav.toString('base64')}"/></svg>\n`;
for (const dir of ['public', 'frontend/public', join('mobile-native-fixed', 'public')]) writeFileSync(join(root, dir, 'favicon.svg'), svg);
console.log(`split at y=${splitY}; wrote logo.png, gridq-emblem.png, gridq-mark.png (x2), favicon.svg (x3)`);
