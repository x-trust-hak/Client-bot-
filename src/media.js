// media.js — Lady Liya Media Converters
//
// .toaudio: extract audio track from a video -> mp3
// .tovideo: not a real conversion target (can't make video from audio),
//           actually implemented as: image -> short static video (some
//           bots do this for status purposes). See command for details.
// .tovoicenote: any audio -> opus/ogg formatted as a WhatsApp voice note (PTT)
//
// All of these need ffmpeg, same as animated stickers. Uses the same
// lazy-require + graceful-failure pattern as stickers.js so a missing
// ffmpeg-static install fails cleanly instead of crashing the bot.

function getFfmpegPath() {
    try {
        const ffmpegStatic = require('ffmpeg-static');
        return ffmpegStatic || null;
    } catch {
        return null;
    }
}

function isFfmpegAvailable() {
    return getFfmpegPath() !== null;
}

function getFfmpeg() {
    const ffmpegPath = getFfmpegPath();
    if (!ffmpegPath) throw new Error('FFMPEG_NOT_INSTALLED');

    let ffmpeg;
    try {
        ffmpeg = require('fluent-ffmpeg');
    } catch {
        throw new Error('FFMPEG_NOT_INSTALLED');
    }

    ffmpeg.setFfmpegPath(ffmpegPath);
    return ffmpeg;
}

async function withTempFiles(inputBuffer, inputExt, outputExt, work) {
    const os = require('os');
    const path = require('path');
    const fsPromises = require('fs').promises;
    const crypto = require('crypto');

    const tmpId = crypto.randomBytes(6).toString('hex');
    const inputPath = path.join(os.tmpdir(), `liya_in_${tmpId}.${inputExt}`);
    const outputPath = path.join(os.tmpdir(), `liya_out_${tmpId}.${outputExt}`);

    await fsPromises.writeFile(inputPath, inputBuffer);

    try {
        await work(inputPath, outputPath);
        return await fsPromises.readFile(outputPath);
    } finally {
        await fsPromises.unlink(inputPath).catch(() => {});
        await fsPromises.unlink(outputPath).catch(() => {});
    }
}

// ── Extract audio track from a video buffer -> mp3 buffer ──
async function videoToAudio(inputBuffer) {
    const ffmpeg = getFfmpeg();
    return withTempFiles(inputBuffer, 'mp4', 'mp3', (inputPath, outputPath) => {
        return new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .noVideo()
                .audioCodec('libmp3lame')
                .toFormat('mp3')
                .on('end', resolve)
                .on('error', reject)
                .save(outputPath);
        });
    });
}

// ── Convert any audio buffer into a WhatsApp-voice-note-compatible
//    opus/ogg buffer (mono, 16kHz, which is what WhatsApp PTT expects) ──
async function audioToVoiceNote(inputBuffer, inputExt = 'mp3') {
    const ffmpeg = getFfmpeg();
    return withTempFiles(inputBuffer, inputExt, 'ogg', (inputPath, outputPath) => {
        return new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .audioChannels(1)
                .audioFrequency(16000)
                .audioCodec('libopus')
                .toFormat('ogg')
                .on('end', resolve)
                .on('error', reject)
                .save(outputPath);
        });
    });
}

// ── Convert a static image into a short silent video (some bots offer
//    this for users who want to post an image as a WhatsApp Status video,
//    or just want a "video version" of an image for compatibility). ──
async function imageToVideo(inputBuffer, durationSec = 5) {
    const ffmpeg = getFfmpeg();
    return withTempFiles(inputBuffer, 'jpg', 'mp4', (inputPath, outputPath) => {
        return new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .loop(durationSec)
                .outputOptions([
                    '-vf', 'scale=720:-2,format=yuv420p',
                    '-c:v', 'libx264',
                    '-t', String(durationSec),
                    '-pix_fmt', 'yuv420p'
                ])
                .toFormat('mp4')
                .on('end', resolve)
                .on('error', reject)
                .save(outputPath);
        });
    });
}

// ── Convert an animated WebP sticker into a real silent MP4 video
//    (the reverse direction of imageToVideo above — useful for reposting
//    a sticker's animation somewhere that only accepts video, e.g. Status).
//
//    IMPORTANT: ffmpeg's built-in `webp` decoder only understands
//    single-frame WebP. Animated WebP stores frames in ANIM/ANMF chunks
//    that ffmpeg's native decoder skips entirely ("skipping unsupported
//    chunk: ANIM/ANMF" -> "image data not found" -> hard failure), since
//    almost no ffmpeg build links libwebpdemux. Feeding the raw animated
//    webp straight to ffmpeg therefore always fails, regardless of how
//    the ffmpeg call is structured.
//
//    Fix: decode each frame ourselves with sharp (already a project
//    dependency; bundled libvips DOES support animated WebP), write them
//    out as PNGs with their real per-frame delay, then hand ffmpeg a
//    concat-demuxer list instead of the raw webp. ──
async function animatedStickerToVideo(inputBuffer) {
    const ffmpeg = getFfmpeg();
    const sharp = require('sharp');
    const os = require('os');
    const path = require('path');
    const fsPromises = require('fs').promises;
    const crypto = require('crypto');

    const tmpId = crypto.randomBytes(6).toString('hex');
    const tmpDir = path.join(os.tmpdir(), `liya_webp_${tmpId}`);
    const outputPath = path.join(os.tmpdir(), `liya_out_${tmpId}.mp4`);
    await fsPromises.mkdir(tmpDir, { recursive: true });

    try {
        const meta = await sharp(inputBuffer, { animated: true }).metadata();
        const pages = meta.pages || 1;
        if (pages <= 1) {
            throw new Error('NOT_ANIMATED'); // single-frame webp — nothing to animate
        }
        const delay = meta.delay || new Array(pages).fill(100);

        const listLines = [];
        for (let i = 0; i < pages; i++) {
            const frameName = `frame_${String(i).padStart(4, '0')}.png`;
            const frameBuffer = await sharp(inputBuffer, { page: i }).png().toBuffer();
            await fsPromises.writeFile(path.join(tmpDir, frameName), frameBuffer);
            // ffmpeg's concat demuxer needs seconds, and a minimum floor so a
            // 0ms-delay frame (some stickers have these) doesn't get dropped
            const durationSec = Math.max((delay[i] || 100) / 1000, 0.02);
            listLines.push(`file '${frameName}'`);
            listLines.push(`duration ${durationSec}`);
        }
        // concat demuxer quirk: the final entry's duration is ignored unless
        // the same file is repeated once more afterwards without a duration
        listLines.push(`file '${`frame_${String(pages - 1).padStart(4, '0')}.png`}'`);

        const listPath = path.join(tmpDir, 'list.txt');
        await fsPromises.writeFile(listPath, listLines.join('\n'));

        await new Promise((resolve, reject) => {
            ffmpeg()
                .input(listPath)
                .inputOptions(['-f', 'concat', '-safe', '0'])
                .outputOptions([
                    '-vf', 'scale=512:-2,format=yuv420p',
                    '-c:v', 'libx264',
                    '-movflags', '+faststart',
                    '-pix_fmt', 'yuv420p'
                ])
                .toFormat('mp4')
                .on('end', resolve)
                .on('error', reject)
                .save(outputPath);
        });

        return await fsPromises.readFile(outputPath);
    } finally {
        await fsPromises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        await fsPromises.unlink(outputPath).catch(() => {});
    }
}

module.exports = {
    isFfmpegAvailable,
    videoToAudio,
    audioToVoiceNote,
    imageToVideo,
    animatedStickerToVideo
};
