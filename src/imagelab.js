// imagelab.js — Lady Liya Distortion Lab & Photo Utilities
//
// Two families of functionality:
//   1. STYLE/DISTORTION FILTERS (16): blurbg, bokeh, pixel, glass, fisheye,
//      swirl, wave, ripple, twirl, kaleidoscope, glitch, crt, scanlines,
//      neon, cyberpunk, rainbow — same single-image-in/buffer-out shape as
//      filters.js. Geometric ones (fisheye/swirl/wave/ripple/twirl/glass/
//      kaleidoscope) use a raw-pixel remap engine since sharp has no
//      built-in arbitrary pixel-warp operation.
//   2. PHOTO UTILITIES (12): autocrop, smartcrop, square, landscape,
//      portrait, border, frame, pad — single image in/out — plus collage,
//      photostrip, contactsheet, beforeafter, which combine several
//      *recent* images from the chat. Since a single WhatsApp message can
//      only carry one image, we auto-cache a small rolling buffer of
//      recent images per chat (see cacheImage/getCachedImages) so these
//      multi-image commands have something to work with.

const sharp = require('sharp');

const IMAGE_CACHE_PREFIX = 'imgcache:';
const IMAGE_CACHE_MAX = 8;
const IMAGE_CACHE_TTL = 30 * 60; // 30 minutes

// ── rolling recent-image cache (per chat) ───────────────────────
async function cacheImage(redisClient, chatId, buffer) {
    const key = IMAGE_CACHE_PREFIX + chatId;
    const thumb = await sharp(buffer).resize(700, 700, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer();
    await redisClient.lPush(key, thumb.toString('base64'));
    await redisClient.lTrim(key, 0, IMAGE_CACHE_MAX - 1);
    await redisClient.expire(key, IMAGE_CACHE_TTL);
}

// newest first
async function getCachedImages(redisClient, chatId, count = IMAGE_CACHE_MAX) {
    const key = IMAGE_CACHE_PREFIX + chatId;
    const entries = await redisClient.lRange(key, 0, count - 1);
    return entries.map(b64 => Buffer.from(b64, 'base64'));
}

// ── raw-pixel remap engine (for geometric warps) ────────────────
// mapFn(x, y, w, h, cx, cy) -> [srcX, srcY]. Nearest-neighbour sampling.
// Downscales large inputs first so the per-pixel JS loop stays fast.
async function remapPixels(buf, mapFn, maxDim = 800) {
    const prepped = await sharp(buf).resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true }).ensureAlpha().toBuffer();
    const { data, info } = await sharp(prepped).raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    const out = Buffer.alloc(data.length);
    const cx = width / 2, cy = height / 2;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const [sxRaw, syRaw] = mapFn(x, y, width, height, cx, cy);
            const sx = Math.round(sxRaw), sy = Math.round(syRaw);
            const outIdx = (y * width + x) * channels;
            if (sx < 0 || sx >= width || sy < 0 || sy >= height) {
                out[outIdx] = 0; out[outIdx + 1] = 0; out[outIdx + 2] = 0; out[outIdx + 3] = 0;
                continue;
            }
            const srcIdx = (sy * width + sx) * channels;
            for (let c = 0; c < channels; c++) out[outIdx + c] = data[srcIdx + c];
        }
    }

    return sharp(out, { raw: { width, height, channels } }).flatten({ background: '#000000' }).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

function shiftHorizontalSync() { /* placeholder to keep section markers grep-able */ }

async function shiftHorizontal(buf, w, h, shift, background = { r: 0, g: 0, b: 0, alpha: 0 }) {
    if (shift === 0) return sharp(buf).ensureAlpha().png().toBuffer();
    if (shift > 0) {
        const extended = await sharp(buf).ensureAlpha()
            .extend({ left: shift, top: 0, right: 0, bottom: 0, background }).png().toBuffer();
        return sharp(extended).extract({ left: 0, top: 0, width: w, height: h }).png().toBuffer();
    }
    const s = -shift;
    const extended = await sharp(buf).ensureAlpha()
        .extend({ left: 0, top: 0, right: s, bottom: 0, background }).png().toBuffer();
    return sharp(extended).extract({ left: s, top: 0, width: w, height: h }).png().toBuffer();
}

async function addVignette(buf, strength = 0.4) {
    const meta = await sharp(buf).metadata();
    const w = meta.width, h = meta.height;
    const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
        <defs><radialGradient id="v" cx="50%" cy="50%" r="72%">
            <stop offset="55%" stop-color="white" stop-opacity="0"/>
            <stop offset="100%" stop-color="black" stop-opacity="${strength}"/>
        </radialGradient></defs>
        <rect width="${w}" height="${h}" fill="url(#v)"/>
    </svg>`;
    return sharp(buf).composite([{ input: Buffer.from(svg), blend: 'multiply' }]);
}

// ════════════════════════════════════════════════════════
// STYLE / DISTORTION FILTERS
// ════════════════════════════════════════════════════════

async function filterBlurbg(buf) {
    const meta = await sharp(buf).metadata();
    const w = meta.width, h = meta.height;
    const blurred = await sharp(buf).blur(14).toBuffer();

    const maskSvg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
        <defs><radialGradient id="m" cx="50%" cy="50%" r="45%">
            <stop offset="0%" stop-color="white" stop-opacity="1"/>
            <stop offset="100%" stop-color="white" stop-opacity="0"/>
        </radialGradient></defs>
        <rect width="${w}" height="${h}" fill="url(#m)"/>
    </svg>`;
    const mask = await sharp(Buffer.from(maskSvg)).png().toBuffer();

    const masked = await sharp(buf).ensureAlpha()
        .composite([{ input: mask, blend: 'dest-in' }])
        .png().toBuffer();

    return sharp(blurred).composite([{ input: masked, blend: 'over' }])
        .jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

async function filterBokeh(buf) {
    const meta = await sharp(buf).metadata();
    const w = meta.width, h = meta.height;
    const blurred = await sharp(buf).blur(6).toBuffer();

    let circles = '';
    for (let i = 0; i < 10; i++) {
        const cx = Math.random() * w, cy = Math.random() * h;
        const r = (Math.random() * 0.05 + 0.03) * Math.max(w, h);
        const op = (Math.random() * 0.3 + 0.25).toFixed(2);
        circles += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="white" fill-opacity="${op}"/>`;
    }
    const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${circles}</svg>`;

    return sharp(blurred).composite([{ input: Buffer.from(svg), blend: 'screen' }])
        .jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

async function filterPixel(buf) {
    const meta = await sharp(buf).metadata();
    const w = meta.width, h = meta.height;
    const blockW = Math.max(1, Math.round(w / 40));
    const blockH = Math.max(1, Math.round(h / 40));

    return sharp(buf)
        .resize(Math.max(1, Math.round(w / blockW)), Math.max(1, Math.round(h / blockH)), { kernel: 'nearest' })
        .resize(w, h, { kernel: 'nearest' })
        .jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

async function filterGlass(buf) {
    return remapPixels(buf, (x, y) => [x + (Math.random() * 2 - 1) * 6, y + (Math.random() * 2 - 1) * 6]);
}

async function filterFisheye(buf) {
    return remapPixels(buf, (x, y, w, h, cx, cy) => {
        const nx = (x - cx) / cx, ny = (y - cy) / cy;
        const r = Math.sqrt(nx * nx + ny * ny);
        if (r > 1 || r === 0) return [x, y];
        const newR = Math.pow(r, 0.6);
        const scale = newR / r;
        return [cx + nx * scale * cx, cy + ny * scale * cy];
    });
}

async function filterSwirl(buf) {
    return remapPixels(buf, (x, y, w, h, cx, cy) => {
        const dx = x - cx, dy = y - cy;
        const r = Math.sqrt(dx * dx + dy * dy);
        const maxR = Math.min(cx, cy);
        if (r > maxR) return [x, y];
        const angle = 2.8 * (1 - r / maxR);
        const cosA = Math.cos(angle), sinA = Math.sin(angle);
        return [cx + dx * cosA - dy * sinA, cy + dx * sinA + dy * cosA];
    });
}

async function filterTwirl(buf) {
    return remapPixels(buf, (x, y, w, h, cx, cy) => {
        const dx = x - cx, dy = y - cy;
        const r = Math.sqrt(dx * dx + dy * dy);
        const maxR = Math.min(cx, cy);
        if (r > maxR) return [x, y];
        const angle = -4.2 * Math.pow(1 - r / maxR, 2);
        const cosA = Math.cos(angle), sinA = Math.sin(angle);
        return [cx + dx * cosA - dy * sinA, cy + dx * sinA + dy * cosA];
    });
}

async function filterWave(buf) {
    return remapPixels(buf, (x, y) => [x + 12 * Math.sin(y * 0.05), y + 12 * Math.cos(x * 0.05)]);
}

async function filterRipple(buf) {
    return remapPixels(buf, (x, y, w, h, cx, cy) => {
        const dx = x - cx, dy = y - cy;
        const r = Math.sqrt(dx * dx + dy * dy);
        if (r === 0) return [x, y];
        const factor = (10 * Math.sin(r * 0.15)) / r;
        return [x + dx * factor, y + dy * factor];
    });
}

async function filterKaleidoscope(buf) {
    const segments = 6;
    return remapPixels(buf, (x, y, w, h, cx, cy) => {
        const dx = x - cx, dy = y - cy;
        const r = Math.sqrt(dx * dx + dy * dy);
        const wedge = (2 * Math.PI) / segments;
        let theta = Math.atan2(dy, dx) % wedge;
        if (theta < 0) theta += wedge;
        if (theta > wedge / 2) theta = wedge - theta;
        return [cx + r * Math.cos(theta), cy + r * Math.sin(theta)];
    });
}

async function filterGlitch(buf) {
    const meta = await sharp(buf).ensureAlpha().metadata();
    const w = meta.width, h = meta.height;
    const shiftAmt = Math.max(3, Math.round(w * 0.015));

    const redOnly = await sharp(buf).ensureAlpha().recomb([[1, 0, 0], [0, 0, 0], [0, 0, 0]]).toBuffer();
    const blueOnly = await sharp(buf).ensureAlpha().recomb([[0, 0, 0], [0, 0, 0], [0, 0, 1]]).toBuffer();
    const redShifted = await shiftHorizontal(redOnly, w, h, shiftAmt);
    const blueShifted = await shiftHorizontal(blueOnly, w, h, -shiftAmt);

    const layers = [
        { input: redShifted, blend: 'add' },
        { input: blueShifted, blend: 'add' }
    ];

    for (let i = 0; i < 4; i++) {
        const stripH = Math.max(2, Math.round(h * 0.02));
        const y = Math.floor(Math.random() * Math.max(1, h - stripH));
        const stripShift = Math.round((Math.random() * 2 - 1) * shiftAmt * 2);
        const strip = await sharp(buf).extract({ left: 0, top: y, width: w, height: stripH }).toBuffer();
        const shiftedStrip = await shiftHorizontal(strip, w, stripH, stripShift);
        layers.push({ input: shiftedStrip, left: 0, top: y });
    }

    return sharp(buf).ensureAlpha().composite(layers).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

async function addScanlinesLayer(buf, opacity = 0.25, lineHeight = 3) {
    const meta = await sharp(buf).metadata();
    const w = meta.width, h = meta.height;
    let rects = '';
    for (let y = 0; y < h; y += lineHeight * 2) {
        rects += `<rect x="0" y="${y}" width="${w}" height="${lineHeight}" fill="black" fill-opacity="${opacity}"/>`;
    }
    const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`;
    return sharp(buf).composite([{ input: Buffer.from(svg), blend: 'multiply' }]);
}

async function filterScanlines(buf) {
    return (await addScanlinesLayer(buf, 0.3, 3)).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

async function filterCrt(buf) {
    const meta = await sharp(buf).ensureAlpha().metadata();
    const w = meta.width, h = meta.height;
    const shiftAmt = Math.max(1, Math.round(w * 0.005));

    const redOnly = await sharp(buf).ensureAlpha().recomb([[1, 0, 0], [0, 0, 0], [0, 0, 0]]).toBuffer();
    const blueOnly = await sharp(buf).ensureAlpha().recomb([[0, 0, 0], [0, 0, 0], [0, 0, 1]]).toBuffer();
    const redShifted = await shiftHorizontal(redOnly, w, h, shiftAmt);
    const blueShifted = await shiftHorizontal(blueOnly, w, h, -shiftAmt);

    const aberrated = await sharp(buf).ensureAlpha()
        .composite([{ input: redShifted, blend: 'add' }, { input: blueShifted, blend: 'add' }])
        .modulate({ brightness: 0.95 })
        .toBuffer();

    const scanned = await (await addScanlinesLayer(aberrated, 0.35, 2)).toBuffer();
    return (await addVignette(scanned, 0.4)).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

async function filterNeon(buf) {
    const gray = await sharp(buf).grayscale().toBuffer();
    const edges = await sharp(gray)
        .convolve({ width: 3, height: 3, kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1] })
        .normalize().toBuffer();
    const tinted = await sharp(edges).ensureAlpha().tint({ r: 80, g: 255, b: 255 }).toBuffer();
    const glow = await sharp(tinted).blur(8).toBuffer();

    return sharp(tinted)
        .composite([{ input: glow, blend: 'screen' }])
        .flatten({ background: '#000000' })
        .jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

async function filterCyberpunk(buf) {
    const { data, info } = await sharp(buf).grayscale().raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    const out = Buffer.alloc(width * height * 3);
    const colorA = [15, 20, 70];   // deep indigo shadows
    const colorB = [255, 40, 170]; // hot magenta highlights
    for (let i = 0, p = 0; i < data.length; i += channels, p += 3) {
        const t = data[i] / 255;
        out[p] = Math.round(colorA[0] + (colorB[0] - colorA[0]) * t);
        out[p + 1] = Math.round(colorA[1] + (colorB[1] - colorA[1]) * t);
        out[p + 2] = Math.round(colorA[2] + (colorB[2] - colorA[2]) * t);
    }

    return sharp(out, { raw: { width, height, channels: 3 } })
        .modulate({ saturation: 1.3 })
        .jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

async function filterRainbow(buf) {
    const meta = await sharp(buf).metadata();
    const w = meta.width, h = meta.height;
    const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
        <defs><linearGradient id="rb" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="red"/><stop offset="16%" stop-color="orange"/>
            <stop offset="33%" stop-color="yellow"/><stop offset="50%" stop-color="green"/>
            <stop offset="66%" stop-color="blue"/><stop offset="83%" stop-color="indigo"/>
            <stop offset="100%" stop-color="violet"/>
        </linearGradient></defs>
        <rect width="${w}" height="${h}" fill="url(#rb)" opacity="0.55"/>
    </svg>`;
    return sharp(buf).composite([{ input: Buffer.from(svg), blend: 'overlay' }])
        .jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

const STYLE_FILTERS = {
    blurbg: filterBlurbg,
    bokeh: filterBokeh,
    pixel: filterPixel,
    glass: filterGlass,
    fisheye: filterFisheye,
    swirl: filterSwirl,
    wave: filterWave,
    ripple: filterRipple,
    twirl: filterTwirl,
    kaleidoscope: filterKaleidoscope,
    glitch: filterGlitch,
    crt: filterCrt,
    scanlines: filterScanlines,
    neon: filterNeon,
    cyberpunk: filterCyberpunk,
    rainbow: filterRainbow
};

async function applyStyleFilter(buf, name) {
    const fn = STYLE_FILTERS[name];
    if (!fn) throw new Error(`Unknown style filter: ${name}`);
    return fn(buf);
}

// ════════════════════════════════════════════════════════
// PHOTO UTILITIES — single image
// ════════════════════════════════════════════════════════

async function autoCrop(buf) {
    try {
        return await sharp(buf).trim({ threshold: 12 }).jpeg({ quality: 92, mozjpeg: true }).toBuffer();
    } catch {
        // trim() throws if it can't find a uniform border to remove
        return sharp(buf).jpeg({ quality: 92, mozjpeg: true }).toBuffer();
    }
}

async function ratioCrop(buf, ratioW, ratioH, position = 'centre') {
    const meta = await sharp(buf).metadata();
    const w = meta.width, h = meta.height;
    let targetW, targetH;
    if (w / h > ratioW / ratioH) { targetH = h; targetW = Math.round(h * ratioW / ratioH); }
    else { targetW = w; targetH = Math.round(w * ratioH / ratioW); }
    return sharp(buf).resize(targetW, targetH, { fit: 'cover', position })
        .jpeg({ quality: 92, mozjpeg: true }).toBuffer();
}

async function smartCrop(buf, ratioW = 1, ratioH = 1) {
    return ratioCrop(buf, ratioW, ratioH, sharp.strategy.attention);
}

async function addBorder(buf, color = '#000000', width = null) {
    const meta = await sharp(buf).metadata();
    const w = width || Math.round(Math.max(meta.width, meta.height) * 0.03);
    return sharp(buf).extend({ top: w, bottom: w, left: w, right: w, background: color })
        .jpeg({ quality: 92, mozjpeg: true }).toBuffer();
}

async function addFrame(buf, color = '#ffffff', accent = '#c9a24b') {
    const meta = await sharp(buf).metadata();
    const inner = Math.max(2, Math.round(Math.max(meta.width, meta.height) * 0.012));
    const outer = Math.max(6, Math.round(Math.max(meta.width, meta.height) * 0.05));
    const withAccent = await sharp(buf).extend({ top: inner, bottom: inner, left: inner, right: inner, background: accent }).toBuffer();
    return sharp(withAccent).extend({ top: outer, bottom: outer, left: outer, right: outer, background: color })
        .jpeg({ quality: 92, mozjpeg: true }).toBuffer();
}

async function padToRatio(buf, ratioW = 1, ratioH = 1, color = '#000000') {
    const meta = await sharp(buf).metadata();
    const w = meta.width, h = meta.height;
    let canvasW, canvasH;
    if (w / h > ratioW / ratioH) { canvasW = w; canvasH = Math.round(w * ratioH / ratioW); }
    else { canvasH = h; canvasW = Math.round(h * ratioW / ratioH); }
    return sharp(buf).resize(canvasW, canvasH, { fit: 'contain', background: color })
        .jpeg({ quality: 92, mozjpeg: true }).toBuffer();
}

// ════════════════════════════════════════════════════════
// PHOTO UTILITIES — multi-image layouts
// ════════════════════════════════════════════════════════

async function buildGrid(buffers, cols, cellW, cellH, gap = 8, background = '#111111') {
    const rows = Math.ceil(buffers.length / cols);
    const canvasW = cols * cellW + (cols + 1) * gap;
    const canvasH = rows * cellH + (rows + 1) * gap;

    const cells = [];
    for (let i = 0; i < buffers.length; i++) {
        const col = i % cols, row = Math.floor(i / cols);
        const resized = await sharp(buffers[i]).resize(cellW, cellH, { fit: 'cover' }).jpeg().toBuffer();
        cells.push({ input: resized, left: gap + col * (cellW + gap), top: gap + row * (cellH + gap) });
    }

    return sharp({ create: { width: canvasW, height: canvasH, channels: 3, background } })
        .composite(cells)
        .jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

async function buildCollage(buffers) {
    const imgs = buffers.slice(0, 4);
    const cols = imgs.length <= 1 ? 1 : 2;
    return buildGrid(imgs, cols, 420, 420, 10, '#111111');
}

async function buildPhotostrip(buffers) {
    const imgs = buffers.slice(0, 4);
    return buildGrid(imgs, 1, 380, 380, 16, '#f5f0e6');
}

async function buildContactsheet(buffers) {
    const imgs = buffers.slice(0, 9);
    const cols = 3;
    return buildGrid(imgs, cols, 220, 220, 6, '#0a0a0a');
}

async function buildBeforeAfter(beforeBuf, afterBuf) {
    const cellW = 420, cellH = 420, gap = 6;
    const before = await sharp(beforeBuf).resize(cellW, cellH, { fit: 'cover' }).jpeg().toBuffer();
    const after = await sharp(afterBuf).resize(cellW, cellH, { fit: 'cover' }).jpeg().toBuffer();

    const canvasW = cellW * 2 + gap;
    return sharp({ create: { width: canvasW, height: cellH, channels: 3, background: '#000000' } })
        .composite([
            { input: before, left: 0, top: 0 },
            { input: after, left: cellW + gap, top: 0 }
        ])
        .jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

module.exports = {
    // cache
    cacheImage,
    getCachedImages,
    // style filters
    applyStyleFilter,
    STYLE_FILTER_NAMES: Object.keys(STYLE_FILTERS),
    // utilities — single image
    autoCrop,
    smartCrop,
    ratioCrop,
    addBorder,
    addFrame,
    padToRatio,
    // utilities — multi image
    buildCollage,
    buildPhotostrip,
    buildContactsheet,
    buildBeforeAfter
};
