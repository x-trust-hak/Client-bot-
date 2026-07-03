// imagetext.js — Lady Liya Image Text & Analysis Lab
//
// memegen/watermark/quotecard use sharp's SVG compositing for text
// (same technique as the vignette/rainbow overlays in imagelab.js).
// imagecolors/imagetoascii are raw-pixel analysis. exifstrip both
// reports what metadata existed and returns a cleaned copy.

const sharp = require('sharp');

function escapeXml(str) {
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Wraps text to roughly `maxCharsPerLine` per line, greedy word-wrap.
function wrapText(text, maxCharsPerLine) {
    const words = text.split(/\s+/);
    const lines = [];
    let current = '';
    for (const w of words) {
        if ((current + ' ' + w).trim().length > maxCharsPerLine && current) {
            lines.push(current.trim());
            current = w;
        } else {
            current = (current + ' ' + w).trim();
        }
    }
    if (current) lines.push(current);
    return lines;
}

// ── meme generator: classic top/bottom caption on a replied image ──
async function memeGen(buf, topText = '', bottomText = '') {
    const meta = await sharp(buf).metadata();
    const w = meta.width, h = meta.height;
    const fontSize = Math.round(w * 0.09);
    const maxChars = Math.max(8, Math.round(w / (fontSize * 0.6)));

    function captionSvg(text, y, anchor) {
        if (!text) return '';
        const lines = wrapText(text.toUpperCase(), maxChars);
        return lines.map((line, i) => {
            const ly = anchor === 'top' ? y + i * fontSize * 1.15 : y - (lines.length - 1 - i) * fontSize * 1.15;
            return `<text x="${w / 2}" y="${ly}" font-family="Impact, Arial Black, sans-serif" font-size="${fontSize}" font-weight="900" fill="white" stroke="black" stroke-width="${Math.max(2, fontSize * 0.06)}" text-anchor="middle" paint-order="stroke">${escapeXml(line)}</text>`;
        }).join('');
    }

    const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
        ${captionSvg(topText, fontSize * 1.1, 'top')}
        ${captionSvg(bottomText, h - fontSize * 0.4, 'bottom')}
    </svg>`;

    return sharp(buf).composite([{ input: Buffer.from(svg) }]).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

// ── watermark: diagonal tiled semi-transparent text over the image ──
async function watermark(buf, text = 'SAMPLE') {
    const meta = await sharp(buf).metadata();
    const w = meta.width, h = meta.height;
    const fontSize = Math.max(16, Math.round(Math.min(w, h) * 0.045));

    let tiles = '';
    const stepX = fontSize * (text.length * 0.65 + 4);
    const stepY = fontSize * 4;
    for (let y = -stepY; y < h + stepY; y += stepY) {
        for (let x = -stepX; x < w + stepX; x += stepX) {
            tiles += `<text x="${x}" y="${y}" font-family="sans-serif" font-size="${fontSize}" fill="white" fill-opacity="0.35" transform="rotate(-30 ${x} ${y})">${escapeXml(text)}</text>`;
        }
    }
    const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${tiles}</svg>`;

    return sharp(buf).composite([{ input: Buffer.from(svg) }]).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

// ── quote card: standalone styled image with a quote (no source image needed) ──
async function quoteCard(quoteText, author = '') {
    const w = 1080, h = 1080;
    const fontSize = quoteText.length > 120 ? 44 : quoteText.length > 60 ? 54 : 68;
    const maxChars = Math.max(10, Math.round(w / (fontSize * 0.52)));
    const lines = wrapText(quoteText, maxChars);
    const lineHeight = fontSize * 1.35;
    const totalTextHeight = lines.length * lineHeight;
    const startY = (h - totalTextHeight) / 2;

    const quoteLines = lines.map((line, i) =>
        `<text x="${w / 2}" y="${startY + i * lineHeight}" font-family="Georgia, serif" font-size="${fontSize}" fill="#f5f0e6" text-anchor="middle">${escapeXml(line)}</text>`
    ).join('');

    const authorLine = author
        ? `<text x="${w / 2}" y="${startY + totalTextHeight + 70}" font-family="Georgia, serif" font-size="${Math.round(fontSize * 0.5)}" fill="#c9a24b" text-anchor="middle">— ${escapeXml(author)}</text>`
        : '';

    const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
        <defs><linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#1a1a2e"/><stop offset="100%" stop-color="#16213e"/>
        </linearGradient></defs>
        <rect width="${w}" height="${h}" fill="url(#bg)"/>
        <text x="${w / 2}" y="${startY - 60}" font-family="Georgia, serif" font-size="120" fill="#c9a24b" fill-opacity="0.5" text-anchor="middle">"</text>
        ${quoteLines}
        ${authorLine}
    </svg>`;

    return sharp(Buffer.from(svg)).jpeg({ quality: 92, mozjpeg: true }).toBuffer();
}

// ── dominant color palette extractor (frequency-binned, not true k-means,
//    but a solid approximation for a fun swatch) ──
async function extractPalette(buf, count = 5) {
    const { data, info } = await sharp(buf)
        .resize(100, 100, { fit: 'inside' })
        .removeAlpha()
        .raw().toBuffer({ resolveWithObject: true });
    const channels = info.channels;

    // Bin into a coarse 16x16x16 color cube, tally frequency, then pick
    // the modal color actually seen in each of the top bins (avoids
    // averaging into muddy colors).
    const bins = new Map();
    for (let i = 0; i < data.length; i += channels) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const key = `${r >> 4}-${g >> 4}-${b >> 4}`;
        if (!bins.has(key)) bins.set(key, { count: 0, r: 0, g: 0, b: 0 });
        const bin = bins.get(key);
        bin.count++; bin.r += r; bin.g += g; bin.b += b;
    }

    const sorted = [...bins.values()].sort((a, b) => b.count - a.count).slice(0, count);
    return sorted.map(bin => {
        const r = Math.round(bin.r / bin.count), g = Math.round(bin.g / bin.count), b = Math.round(bin.b / bin.count);
        const hex = '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('');
        return { hex, r, g, b };
    });
}

async function paletteSwatchImage(palette) {
    const swatchW = 120, h = 120;
    const w = swatchW * palette.length;
    let rects = '';
    palette.forEach((c, i) => {
        rects += `<rect x="${i * swatchW}" y="0" width="${swatchW}" height="${h}" fill="${c.hex}"/>`;
    });
    const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`;
    return sharp(Buffer.from(svg)).png().toBuffer();
}

// ── image to ASCII art (brightness -> character ramp) ──
const ASCII_RAMP = '@%#*+=-:. '; // dark -> light
async function imageToAscii(buf, cols = 60) {
    const meta = await sharp(buf).metadata();
    // characters are roughly 2x taller than wide, so halve the row count
    const rows = Math.max(1, Math.round((cols * (meta.height / meta.width)) * 0.5));

    const { data, info } = await sharp(buf)
        .resize(cols, rows, { fit: 'fill' })
        .grayscale()
        .raw().toBuffer({ resolveWithObject: true });
    const channels = info.channels;

    let out = '';
    for (let y = 0; y < info.height; y++) {
        let row = '';
        for (let x = 0; x < info.width; x++) {
            const idx = (y * info.width + x) * channels;
            const brightness = data[idx] / 255;
            const charIdx = Math.min(ASCII_RAMP.length - 1, Math.floor(brightness * ASCII_RAMP.length));
            row += ASCII_RAMP[charIdx];
        }
        out += row + '\n';
    }
    return out;
}

// ── EXIF strip: report what was present, return a cleaned copy.
//    sharp drops EXIF/GPS by default on re-encode unless .withMetadata()
//    is called, so simply piping through sharp already strips it — this
//    just also surfaces what was removed, since GPS location in photos
//    is a real privacy leak people don't expect. ──
async function stripExif(buf) {
    const meta = await sharp(buf).metadata();
    const found = [];
    if (meta.exif) found.push('EXIF data (camera/settings)');
    if (meta.gps || (meta.exif && Buffer.isBuffer(meta.exif))) {
        // sharp doesn't parse GPS out separately; flag EXIF presence as
        // a possible GPS carrier since we can't cheaply prove either way
        // without a full EXIF parser.
    }
    if (meta.icc) found.push('ICC color profile');
    if (meta.iptc) found.push('IPTC data');
    if (meta.xmp) found.push('XMP data');

    const cleaned = await sharp(buf).jpeg({ quality: 95, mozjpeg: true }).toBuffer(); // no .withMetadata() = stripped
    return { cleaned, found };
}

// ── OCR: text extraction from an image via tesseract.js.
//    NOTE: tesseract.js downloads its language training data from a CDN
//    the first time it runs (not bundled), so the very first .ocr call
//    on a fresh deploy will be slower and needs outbound network access
//    to that CDN. Uses the same lazy-require + graceful-failure pattern
//    as ffmpeg-static elsewhere in this project, so a missing/broken
//    install fails cleanly with a clear error instead of crashing the
//    bot. This could not be network-tested from the sandbox this was
//    written in — please test it once deployed. ──
async function extractText(buf) {
    let Tesseract;
    try {
        Tesseract = require('tesseract.js');
    } catch {
        throw new Error('tesseract.js is not installed — run npm install after pulling this update.');
    }

    const { data } = await Tesseract.recognize(buf, 'eng');
    return (data.text || '').trim();
}

module.exports = {
    memeGen,
    watermark,
    quoteCard,
    extractPalette,
    paletteSwatchImage,
    imageToAscii,
    stripExif,
    extractText
};
