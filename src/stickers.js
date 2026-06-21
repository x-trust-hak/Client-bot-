// stickers.js — Lady Liya Sticker Maker
//
// Static stickers: image buffer -> WebP via `sharp` (already a dependency,
// no new install needed). Resizes/pads to a square WebP, which is what
// WhatsApp expects for sticker messages.
//
// Animated stickers: video/gif buffer -> animated WebP via `fluent-ffmpeg`
// + `ffmpeg-static`. These are NEW dependencies — see the try/catch guard
// below. If they aren't installed yet (e.g. package.json was updated but
// `npm install` hasn't run on the deployed instance), animated conversion
// fails gracefully with a clear message instead of crashing the bot.

const sharp = require('sharp');

const STICKER_SIZE = 512; // WhatsApp's standard sticker canvas size

// ── Static image -> WebP sticker buffer ──
async function imageToSticker(inputBuffer) {
    const output = await sharp(inputBuffer)
        .resize(STICKER_SIZE, STICKER_SIZE, {
            fit: 'contain',
            background: { r: 0, g: 0, b: 0, alpha: 0 } // transparent padding
        })
        .webp({ quality: 90 })
        .toBuffer();
    return output;
}

// ── Lazy-check whether ffmpeg dependencies are actually installed.
//    Returns the ffmpeg path if available, or null if not. Never throws. ──
function getFfmpegPath() {
    try {
        const ffmpegStatic = require('ffmpeg-static');
        return ffmpegStatic || null;
    } catch {
        return null; // ffmpeg-static not installed
    }
}

function isAnimatedStickerSupported() {
    return getFfmpegPath() !== null;
}

// ── Video/GIF buffer -> animated WebP sticker buffer.
//    Throws a clear error if ffmpeg dependencies aren't installed, so the
//    caller can show a friendly "not available yet" message rather than
//    a confusing stack trace. ──
async function videoToAnimatedSticker(inputBuffer, maxDurationSec = 6) {
    const ffmpegPath = getFfmpegPath();
    if (!ffmpegPath) {
        throw new Error('ANIMATED_STICKERS_NOT_INSTALLED');
    }

    // Lazy-require fluent-ffmpeg too, for the same reason — don't blow up
    // at module-load time if it's missing, only when actually needed.
    let ffmpeg;
    try {
        ffmpeg = require('fluent-ffmpeg');
    } catch {
        throw new Error('ANIMATED_STICKERS_NOT_INSTALLED');
    }

    ffmpeg.setFfmpegPath(ffmpegPath);

    const os = require('os');
    const path = require('path');
    const fsPromises = require('fs').promises;
    const crypto = require('crypto');

    const tmpId = crypto.randomBytes(6).toString('hex');
    const inputPath = path.join(os.tmpdir(), `liya_in_${tmpId}`);
    const outputPath = path.join(os.tmpdir(), `liya_out_${tmpId}.webp`);

    await fsPromises.writeFile(inputPath, inputBuffer);

    try {
        await new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .outputOptions([
                    '-vcodec', 'libwebp',
                    '-vf', `scale=${STICKER_SIZE}:${STICKER_SIZE}:force_original_aspect_ratio=decrease,fps=15,pad=${STICKER_SIZE}:${STICKER_SIZE}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`,
                    '-loop', '0',
                    '-preset', 'default',
                    '-an', // strip audio — WhatsApp stickers are silent
                    '-vsync', '0',
                    '-t', String(maxDurationSec)
                ])
                .toFormat('webp')
                .on('end', resolve)
                .on('error', reject)
                .save(outputPath);
        });

        const result = await fsPromises.readFile(outputPath);
        return result;
    } finally {
        // Always clean up temp files, even if conversion failed
        await fsPromises.unlink(inputPath).catch(() => {});
        await fsPromises.unlink(outputPath).catch(() => {});
    }
}

module.exports = {
    STICKER_SIZE,
    imageToSticker,
    isAnimatedStickerSupported,
    videoToAnimatedSticker
};
