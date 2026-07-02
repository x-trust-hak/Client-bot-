// filters.js — Lady Liya Image Filter Lab
//
// 20 image effects built entirely on `sharp` (already a project dependency,
// no new packages needed). Some are native sharp operations (grayscale,
// negate, blur, sharpen, median, recomb); others (posterize, solarize,
// vignette, sketch, cartoon-family) are composed from sharp primitives —
// raw pixel mapping for per-pixel math, and blend-mode compositing for
// everything else (dodge/screen/multiply overlays).
//
// Each filter takes a buffer in, returns a Promise<Buffer> (JPEG) out.
// applyImageFilter(buffer, name) is the single entry point case.js calls.

const sharp = require('sharp');

// ── shared helpers ──────────────────────────────────────────────

// Runs `fn(r,g,b) -> [r,g,b]` over every pixel's RGB channels, leaving any
// alpha channel untouched. Used for per-pixel math sharp has no op for
// (posterize, solarize).
async function mapPixelsRGB(buf, fn) {
    const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
    const channels = info.channels;
    for (let i = 0; i < data.length; i += channels) {
        const [r, g, b] = fn(data[i], data[i + 1], data[i + 2]);
        data[i] = r; data[i + 1] = g; data[i + 2] = b;
    }
    return sharp(data, { raw: { width: info.width, height: info.height, channels } })
        .jpeg({ quality: 90, mozjpeg: true })
        .toBuffer();
}

// Black-on-transparent-ish edge mask (for cartoon/comic/animefy line art),
// returned as a grayscale buffer sized to match the source.
async function edgeMask(buf, threshold = 40) {
    const gray = await sharp(buf).grayscale().median(3).toBuffer();
    return sharp(gray)
        .convolve({ width: 3, height: 3, kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1] })
        .threshold(threshold)
        .negate() // black lines on white
        .toBuffer();
}

async function addVignette(buf, strength = 0.45) {
    const meta = await sharp(buf).metadata();
    const w = meta.width, h = meta.height;
    const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
        <defs><radialGradient id="v" cx="50%" cy="50%" r="72%">
            <stop offset="55%" stop-color="white" stop-opacity="0"/>
            <stop offset="100%" stop-color="black" stop-opacity="${strength}"/>
        </radialGradient></defs>
        <rect width="${w}" height="${h}" fill="url(#v)"/>
    </svg>`;
    return sharp(buf)
        .composite([{ input: Buffer.from(svg), blend: 'multiply' }])
        .jpeg({ quality: 90, mozjpeg: true })
        .toBuffer();
}

// Flatten smooth color regions + posterize + overlay black line art —
// the shared engine behind cartoon / comic / animefy, tuned per-preset.
async function cartoonify(buf, { medianSize = 7, saturation = 1.4, levels = 5, edgeThreshold = 40 } = {}) {
    const flattened = await sharp(buf)
        .median(medianSize)
        .modulate({ saturation })
        .toBuffer();

    const posterized = await posterize(flattened, levels);
    const edges = await edgeMask(buf, edgeThreshold);

    return sharp(posterized)
        .composite([{ input: edges, blend: 'multiply' }])
        .jpeg({ quality: 90, mozjpeg: true })
        .toBuffer();
}

// ── standalone filters (return raw buffers, reused by cartoonify too) ──

async function posterize(buf, levels = 4) {
    const step = 255 / (levels - 1);
    const raw = await sharp(buf).raw().toBuffer({ resolveWithObject: true }).then(({ data, info }) => {
        for (let i = 0; i < data.length; i += info.channels) {
            for (let c = 0; c < 3; c++) {
                data[i + c] = Math.round(Math.round(data[i + c] / step) * step);
            }
        }
        return { data, info };
    });
    return sharp(raw.data, { raw: { width: raw.info.width, height: raw.info.height, channels: raw.info.channels } })
        .jpeg({ quality: 90, mozjpeg: true })
        .toBuffer();
}

// ── the 20 filters ──────────────────────────────────────────────

async function filterSketch(buf) {
    const gray = await sharp(buf).grayscale().toBuffer();
    const invertedBlur = await sharp(gray).negate().blur(18).toBuffer();
    return sharp(gray)
        .composite([{ input: invertedBlur, blend: 'colour-dodge' }])
        .jpeg({ quality: 90, mozjpeg: true })
        .toBuffer();
}

async function filterPencil(buf) {
    const gray = await sharp(buf).grayscale().toBuffer();
    return sharp(gray)
        .convolve({ width: 3, height: 3, kernel: [0, -1, 0, -1, 5, -1, 0, -1, 0] })
        .negate()
        .normalize()
        .jpeg({ quality: 90, mozjpeg: true })
        .toBuffer();
}

async function filterCartoon(buf) {
    return cartoonify(buf, { medianSize: 7, saturation: 1.4, levels: 5, edgeThreshold: 40 });
}

async function filterComic(buf) {
    // bolder lines, harder color steps, punchier saturation
    return cartoonify(buf, { medianSize: 5, saturation: 1.6, levels: 3, edgeThreshold: 28 });
}

async function filterAnimefy(buf) {
    // softer, glossier — heavier smoothing, gentler lines
    return cartoonify(buf, { medianSize: 9, saturation: 1.5, levels: 6, edgeThreshold: 55 });
}

async function filterOilpaint(buf) {
    return sharp(buf)
        .median(9)
        .modulate({ saturation: 1.2 })
        .sharpen({ sigma: 0.8 })
        .jpeg({ quality: 90, mozjpeg: true })
        .toBuffer();
}

async function filterVintage(buf) {
    const sepia = await filterSepia(buf);
    const toned = await sharp(sepia).modulate({ brightness: 0.95, saturation: 0.85 }).linear(0.92, 8).toBuffer();
    return addVignette(toned, 0.35);
}

async function filterSepia(buf) {
    return sharp(buf)
        .flatten({ background: '#ffffff' })
        .recomb([
            [0.393, 0.769, 0.189],
            [0.349, 0.686, 0.168],
            [0.272, 0.534, 0.131]
        ])
        .jpeg({ quality: 90, mozjpeg: true })
        .toBuffer();
}

async function filterGrayscale(buf) {
    return sharp(buf).grayscale().jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

async function filterNegative(buf) {
    return sharp(buf).negate().jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

async function filterSolarize(buf, threshold = 128) {
    return mapPixelsRGB(buf, (r, g, b) => [
        r > threshold ? 255 - r : r,
        g > threshold ? 255 - g : g,
        b > threshold ? 255 - b : b
    ]);
}

async function filterPosterize(buf) {
    return posterize(buf, 4);
}

async function filterEmboss(buf) {
    const gray = await sharp(buf).grayscale().toBuffer();
    return sharp(gray)
        .convolve({ width: 3, height: 3, kernel: [-2, -1, 0, -1, 1, 1, 0, 1, 2], offset: 128 })
        .jpeg({ quality: 90, mozjpeg: true })
        .toBuffer();
}

async function filterSharpen(buf) {
    return sharp(buf).sharpen({ sigma: 2.2, m1: 1, m2: 2 }).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

async function filterSoften(buf) {
    return sharp(buf).blur(3.5).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

async function filterDenoise(buf) {
    return sharp(buf).median(3).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

async function filterSmooth(buf) {
    return sharp(buf).median(5).blur(1).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

async function filterGlow(buf) {
    const blurred = await sharp(buf).blur(15).modulate({ brightness: 1.3 }).toBuffer();
    return sharp(buf)
        .composite([{ input: blurred, blend: 'screen' }])
        .jpeg({ quality: 90, mozjpeg: true })
        .toBuffer();
}

async function filterVignette(buf) {
    return addVignette(buf, 0.5);
}

async function filterOutline(buf) {
    const gray = await sharp(buf).grayscale().toBuffer();
    return sharp(gray)
        .convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0] })
        .normalize()
        .negate()
        .jpeg({ quality: 90, mozjpeg: true })
        .toBuffer();
}

// ── dispatcher ───────────────────────────────────────────────────

const FILTERS = {
    sketch: filterSketch,
    pencil: filterPencil,
    cartoon: filterCartoon,
    comic: filterComic,
    animefy: filterAnimefy,
    oilpaint: filterOilpaint,
    vintage: filterVintage,
    sepia: filterSepia,
    grayscale: filterGrayscale,
    negative: filterNegative,
    solarize: filterSolarize,
    posterize: filterPosterize,
    emboss: filterEmboss,
    sharpen: filterSharpen,
    soften: filterSoften,
    denoise: filterDenoise,
    smooth: filterSmooth,
    glow: filterGlow,
    vignette: filterVignette,
    outline: filterOutline
};

async function applyImageFilter(buf, name) {
    const fn = FILTERS[name];
    if (!fn) throw new Error(`Unknown filter: ${name}`);
    return fn(buf);
}

module.exports = {
    applyImageFilter,
    FILTER_NAMES: Object.keys(FILTERS),
    // exported individually too, in case another module wants direct access
    filterSketch, filterPencil, filterCartoon, filterComic, filterAnimefy,
    filterOilpaint, filterVintage, filterSepia, filterGrayscale, filterNegative,
    filterSolarize, filterPosterize, filterEmboss, filterSharpen, filterSoften,
    filterDenoise, filterSmooth, filterGlow, filterVignette, filterOutline
};
