import sharp from 'sharp';

// Phone cameras send 3000x4000 JPEGs; 1600px on the long side is plenty to
// read a meter or pole number and keeps each photo around 100-200 KB.
const PHOTO_MAX_EDGE = 1600;
const PHOTO_WEBP_QUALITY = 75;

// Stage tags the crew app sends in metadata.stage, burned into the photo.
export const PHOTO_STAGES = { work_started: 'WORK STARTED', work_finished: 'WORK FINISHED' };

export function decodePhotoDataUrl(dataUrl) {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!match) throw new Error('Expected a JPEG, PNG, or WebP data URL');
  return { contentType: match[1], buffer: Buffer.from(match[2], 'base64') };
}

const xmlEscape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const finite = (n) => n !== null && n !== undefined && n !== '' && Number.isFinite(Number(n));

// The watermark's text lines, top to bottom; empty when there is nothing to
// stamp. watermark: { stage, lat, lon, at }.
export function watermarkLines({ stage, lat, lon, at } = {}) {
  const lines = [];
  if (PHOTO_STAGES[stage]) lines.push(PHOTO_STAGES[stage]);
  if (finite(lat) && finite(lon)) lines.push(`Lat ${Number(lat).toFixed(6)}  Long ${Number(lon).toFixed(6)}`);
  if (lines.length && at && !Number.isNaN(Date.parse(at))) {
    lines.push(new Date(at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }));
  }
  return lines;
}

// Light text in the bottom-left corner: white at low opacity with a faint
// shadow, so it reads on any background without hiding the photo.
function watermarkSvg(width, height, lines) {
  const size = Math.max(14, Math.round(Math.min(width, height) * 0.03));
  const gap = Math.round(size * 1.3);
  const x = Math.round(size * 0.8);
  const y0 = height - Math.round(size * 0.8) - gap * (lines.length - 1);
  const text = lines.map((line, i) => {
    const big = i === 0 && Object.values(PHOTO_STAGES).includes(line);
    return `<text x="${x}" y="${y0 + gap * i}" font-size="${big ? Math.round(size * 1.15) : size}" font-weight="${big ? 700 : 500}">${xmlEscape(line)}</text>`;
  }).join('');
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <g font-family="DejaVu Sans, Arial, sans-serif" fill="#000" fill-opacity="0.18" transform="translate(1.5 1.5)">${text}</g>
    <g font-family="DejaVu Sans, Arial, sans-serif" fill="#fff" fill-opacity="0.5">${text}</g>
  </svg>`);
}

export async function compressPhoto(buffer, watermark) {
  const resized = await sharp(buffer)
    .rotate() // apply EXIF orientation before the metadata is dropped
    .resize(PHOTO_MAX_EDGE, PHOTO_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
    .toBuffer({ resolveWithObject: true });
  const lines = watermarkLines(watermark);
  let img = sharp(resized.data);
  if (lines.length) img = img.composite([{ input: watermarkSvg(resized.info.width, resized.info.height, lines), top: 0, left: 0 }]);
  const { data, info } = await img.webp({ quality: PHOTO_WEBP_QUALITY }).toBuffer({ resolveWithObject: true });
  return { buffer: data, contentType: 'image/webp', width: info.width, height: info.height };
}
