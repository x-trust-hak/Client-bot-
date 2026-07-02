// retouch.js — Lady Liya Retouch & Format Lab
//
// IMPORTANT CAVEAT, read before wiring commands to these: none of this
// is generative AI. There's no diffusion/inpainting model in this
// project, so "outpaint" and object-removal here are classic
// non-generative tricks (blurred edge-extension, blur-smear patching)
// — not true content-aware fill. They work fine on simple/uniform
// backgrounds (sky, walls, plain floors) and will look obviously fake
// on busy/detailed ones. Every command that uses one of these says so
// in its usage text so nobody's surprised by the result.
//
// .uncensor was intentionally NOT implemented — see the note in the
// chat reply for why.

const sharp = require('sharp');

// ── outpaint: extend canvas via a blurred, scaled-up copy of the
//    image itself as the new "background", with the original centered
//    on top at full sharpness. No new content is invented. ──
async function outpaint(buf, extendPx = 100) {
    const meta = await sharp(buf).metadata();
    const w = meta.width, h = meta.height;
    const canvasW = w + extendPx * 2, canvasH = h + extendPx * 2;

    const bg = await sharp(buf).resize(canvasW, canvasH, { fit: 'cover' }).blur(35).toBuffer();
    const fg = await sharp(buf).jpeg().toBuffer();

    return sharp(bg)
        .composite([{ input: fg, left: extendPx, top: extendPx }])
        .jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

// ── patch fill: samples a ring of context around a rectangular region
//    and blur-smears it over that region. Region given as fractions
//    (0-1) of image width/height so it works at any resolution. ──
async function patchFill(buf, leftFrac, topFrac, rightFrac, bottomFrac) {
    const meta = await sharp(buf).metadata();
    const w = meta.width, h = meta.height;

    const left = Math.round(leftFrac * w), top = Math.round(topFrac * h);
    const right = Math.round(rightFrac * w), bottom = Math.round(bottomFrac * h);
    const boxW = right - left, boxH = bottom - top;
    if (boxW <= 2 || boxH <= 2) throw new Error('Region too small or invalid');

    const margin = Math.round(Math.max(boxW, boxH) * 0.7);
    const sLeft = Math.max(0, left - margin), sTop = Math.max(0, top - margin);
    const sRight = Math.min(w, right + margin), sBottom = Math.min(h, bottom + margin);

    const context = await sharp(buf)
        .extract({ left: sLeft, top: sTop, width: sRight - sLeft, height: sBottom - sTop })
        .blur(30)
        .toBuffer();

    const relLeft = left - sLeft, relTop = top - sTop;
    const fillPiece = await sharp(context)
        .extract({ left: relLeft, top: relTop, width: boxW, height: boxH })
        .blur(12)
        .toBuffer();

    return sharp(buf)
        .composite([{ input: fillPiece, left, top }])
        .jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

// ── smart resize: resize to exact target dimensions using
//    attention-based cropping so the salient subject stays intact
//    instead of being squashed/stretched or center-cropped blindly. ──
async function smartResize(buf, targetW, targetH) {
    return sharp(buf)
        .resize(targetW, targetH, { fit: 'cover', position: sharp.strategy.attention })
        .jpeg({ quality: 92, mozjpeg: true }).toBuffer();
}

// ── autofix: one-click tone/denoise/sharpen pass ──
async function autoFix(buf) {
    return sharp(buf)
        .median(3)                                   // light denoise
        .normalize()                                 // auto contrast stretch
        .modulate({ brightness: 1.05, saturation: 1.06 })
        .sharpen({ sigma: 1.0 })
        .jpeg({ quality: 92, mozjpeg: true }).toBuffer();
}

// ── depth blur: portrait-mode style background blur. Same family of
//    trick as imagelab's blurbg, but with a taller elliptical mask
//    biased toward the upper-middle of frame — better suited to a
//    head-and-shoulders portrait than blurbg's plain circle. ──
async function depthBlur(buf) {
    const meta = await sharp(buf).metadata();
    const w = meta.width, h = meta.height;
    const blurred = await sharp(buf).blur(16).toBuffer();

    const feather = Math.round(Math.min(w, h) * 0.06);
    const maskSvg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
        <defs><filter id="f" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="${feather}"/>
        </filter></defs>
        <ellipse cx="${w / 2}" cy="${h * 0.44}" rx="${w * 0.3}" ry="${h * 0.4}" fill="white" filter="url(#f)"/>
    </svg>`;
    const mask = await sharp(Buffer.from(maskSvg)).png().toBuffer();

    const masked = await sharp(buf).ensureAlpha()
        .composite([{ input: mask, blend: 'dest-in' }])
        .png().toBuffer();

    return sharp(blurred)
        .composite([{ input: masked, blend: 'over' }])
        .jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

// ── polaroid: square-ish crop + classic thick-bottom off-white frame ──
async function polaroid(buf) {
    const cropped = await sharp(buf)
        .resize(600, 600, { fit: 'cover', position: sharp.strategy.attention })
        .modulate({ saturation: 0.92, brightness: 1.03 })
        .toBuffer();

    return sharp(cropped)
        .extend({ top: 28, bottom: 110, left: 28, right: 28, background: '#fdfdf6' })
        .jpeg({ quality: 92, mozjpeg: true }).toBuffer();
}

// ── film: warm-leaning color grade + fine grain + gentle vignette ──
async function filmEffect(buf) {
    const meta = await sharp(buf).metadata();
    const w = meta.width, h = meta.height;

    const graded = await sharp(buf)
        .linear([1.06, 1.0, 0.9], [3, 0, 6]) // lift reds/lower blues slightly = warm film cast
        .modulate({ saturation: 1.08 })
        .toBuffer();

    const grainSvg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
        <filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch"/>
        <feColorMatrix type="saturate" values="0"/></filter>
        <rect width="${w}" height="${h}" filter="url(#n)" opacity="0.10"/>
    </svg>`;
    const grained = await sharp(graded)
        .composite([{ input: Buffer.from(grainSvg), blend: 'overlay' }])
        .toBuffer();

    const vignetteSvg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
        <defs><radialGradient id="v" cx="50%" cy="50%" r="75%">
            <stop offset="60%" stop-color="white" stop-opacity="0"/>
            <stop offset="100%" stop-color="black" stop-opacity="0.3"/>
        </radialGradient></defs>
        <rect width="${w}" height="${h}" fill="url(#v)"/>
    </svg>`;

    return sharp(grained)
        .composite([{ input: Buffer.from(vignetteSvg), blend: 'multiply' }])
        .jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

// ── passport: crop to a standard photo-ID pixel size. NOTE: this only
//    handles crop/aspect/size — it does NOT verify background color,
//    head position/size ratio, expression, or lighting, all of which
//    most countries also require for an officially valid passport
//    photo. Treat this as a starting template, not a compliance
//    guarantee. ──
const PASSPORT_SIZES = {
    us: [600, 600],       // 2x2in @ 300dpi
    uk: [413, 531],       // 35x45mm @ ~300dpi
    schengen: [413, 531], // 35x45mm @ ~300dpi
    india: [600, 600]     // 2x2in @ 300dpi
};

async function passportCrop(buf, sizeKey = 'us') {
    const [w, h] = PASSPORT_SIZES[sizeKey] || PASSPORT_SIZES.us;
    return sharp(buf)
        .resize(w, h, { fit: 'cover', position: sharp.strategy.attention })
        .jpeg({ quality: 95, mozjpeg: true }).toBuffer();
}

module.exports = {
    outpaint,
    patchFill,
    smartResize,
    autoFix,
    depthBlur,
    polaroid,
    filmEffect,
    passportCrop,
    PASSPORT_SIZES: Object.keys(PASSPORT_SIZES)
};
