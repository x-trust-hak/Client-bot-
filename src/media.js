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

// ── Generic audio format converter (covers opus/wav/ogg/m4a/aac/flac/mp3) ──
const AUDIO_CODECS = {
    mp3: { codec: 'libmp3lame', format: 'mp3' },
    opus: { codec: 'libopus', format: 'opus' },
    wav: { codec: 'pcm_s16le', format: 'wav' },
    ogg: { codec: 'libvorbis', format: 'ogg' },
    m4a: { codec: 'aac', format: 'ipod' }, // 'ipod' muxer is ffmpeg's m4a container
    aac: { codec: 'aac', format: 'adts' },
    flac: { codec: 'flac', format: 'flac' }
};

async function convertAudioFormat(inputBuffer, inputExt, targetFormat) {
    const spec = AUDIO_CODECS[targetFormat];
    if (!spec) throw new Error(`Unsupported target audio format: ${targetFormat}`);
    const ffmpeg = getFfmpeg();
    return withTempFiles(inputBuffer, inputExt, targetFormat, (inputPath, outputPath) => {
        return new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .audioCodec(spec.codec)
                .toFormat(spec.format)
                .on('end', resolve)
                .on('error', reject)
                .save(outputPath);
        });
    });
}

// ── GIF -> MP4 (ffmpeg decodes GIF animation natively, unlike animated WebP) ──
async function gifToVideo(inputBuffer) {
    const ffmpeg = getFfmpeg();
    return withTempFiles(inputBuffer, 'gif', 'mp4', (inputPath, outputPath) => {
        return new Promise((resolve, reject) => {
            ffmpeg(inputPath)
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
    });
}

// ── Video -> GIF ──
async function videoToGif(inputBuffer, maxDurationSec = 6) {
    const ffmpeg = getFfmpeg();
    return withTempFiles(inputBuffer, 'mp4', 'gif', (inputPath, outputPath) => {
        return new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .outputOptions([
                    '-t', String(maxDurationSec),
                    '-vf', 'fps=12,scale=400:-1:flags=lanczos'
                ])
                .toFormat('gif')
                .on('end', resolve)
                .on('error', reject)
                .save(outputPath);
        });
    });
}

// ── Animated WebP sticker -> GIF (reuses the same sharp frame-extraction
//    trick as animatedStickerToVideo, since ffmpeg can't decode the source
//    either way — just retargets the concat output to .gif). ──
async function animatedStickerToGif(inputBuffer) {
    const ffmpeg = getFfmpeg();
    const sharp = require('sharp');
    const os = require('os');
    const path = require('path');
    const fsPromises = require('fs').promises;
    const crypto = require('crypto');

    const tmpId = crypto.randomBytes(6).toString('hex');
    const tmpDir = path.join(os.tmpdir(), `liya_webp_${tmpId}`);
    const outputPath = path.join(os.tmpdir(), `liya_out_${tmpId}.gif`);
    await fsPromises.mkdir(tmpDir, { recursive: true });

    try {
        const meta = await sharp(inputBuffer, { animated: true }).metadata();
        const pages = meta.pages || 1;
        if (pages <= 1) throw new Error('NOT_ANIMATED');
        const delay = meta.delay || new Array(pages).fill(100);

        const listLines = [];
        for (let i = 0; i < pages; i++) {
            const frameName = `frame_${String(i).padStart(4, '0')}.png`;
            const frameBuffer = await sharp(inputBuffer, { page: i }).png().toBuffer();
            await fsPromises.writeFile(path.join(tmpDir, frameName), frameBuffer);
            const durationSec = Math.max((delay[i] || 100) / 1000, 0.02);
            listLines.push(`file '${frameName}'`);
            listLines.push(`duration ${durationSec}`);
        }
        listLines.push(`file '${`frame_${String(pages - 1).padStart(4, '0')}.png`}'`);

        const listPath = path.join(tmpDir, 'list.txt');
        await fsPromises.writeFile(listPath, listLines.join('\n'));

        await new Promise((resolve, reject) => {
            ffmpeg()
                .input(listPath)
                .inputOptions(['-f', 'concat', '-safe', '0'])
                .outputOptions(['-vf', 'scale=400:-1:flags=lanczos'])
                .toFormat('gif')
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

// ── Reverse a video (picture + sound) ──
async function reverseVideo(inputBuffer) {
    const ffmpeg = getFfmpeg();
    return withTempFiles(inputBuffer, 'mp4', 'mp4', (inputPath, outputPath) => {
        return new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .outputOptions(['-vf', 'reverse', '-af', 'areverse'])
                .toFormat('mp4')
                .on('end', resolve)
                .on('error', reject)
                .save(outputPath);
        });
    });
}

// ── Reverse an audio file ──
async function reverseAudio(inputBuffer, inputExt = 'mp3') {
    const ffmpeg = getFfmpeg();
    return withTempFiles(inputBuffer, inputExt, inputExt, (inputPath, outputPath) => {
        return new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .audioFilters('areverse')
                .on('end', resolve)
                .on('error', reject)
                .save(outputPath);
        });
    });
}

// ── Rewrite the "title" metadata tag on an audio/video file, without
//    re-encoding (-c copy — fast, lossless). ──
async function renameMediaMetadata(inputBuffer, inputExt, newTitle) {
    const ffmpeg = getFfmpeg();
    return withTempFiles(inputBuffer, inputExt, inputExt, (inputPath, outputPath) => {
        return new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .outputOptions(['-c', 'copy', '-metadata', `title=${newTitle}`])
                .on('end', resolve)
                .on('error', reject)
                .save(outputPath);
        });
    });
}

// ── Lossy re-encode to shrink a video file (higher CRF = smaller/lower quality) ──
async function compressVideo(inputBuffer, crf = 32) {
    const ffmpeg = getFfmpeg();
    return withTempFiles(inputBuffer, 'mp4', 'mp4', (inputPath, outputPath) => {
        return new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .outputOptions(['-vcodec', 'libx264', '-crf', String(crf), '-preset', 'veryfast', '-acodec', 'aac', '-b:a', '96k'])
                .toFormat('mp4')
                .on('end', resolve)
                .on('error', reject)
                .save(outputPath);
        });
    });
}

// ── Lossy re-encode to shrink an image file (sharp, JPEG quality knob) ──
async function compressImage(inputBuffer, quality = 50) {
    const sharp = require('sharp');
    return sharp(inputBuffer).jpeg({ quality, mozjpeg: true }).toBuffer();
}

// ── .remini — basic local image enhancement (sharpen + mild upscale +
//    contrast normalize). This is NOT true AI super-resolution — there's
//    no free/legitimate public API for that — it's a best-effort quality
//    boost using sharp alone, so it works with zero new dependencies and
//    no API key. Good for slightly soft/blurry photos; won't work
//    miracles on heavily compressed or tiny source images. ──
async function enhanceImage(inputBuffer, scale = 1.5) {
    const sharp = require('sharp');
    const meta = await sharp(inputBuffer).metadata();
    const targetWidth = Math.round((meta.width || 512) * scale);
    const targetHeight = Math.round((meta.height || 512) * scale);

    return sharp(inputBuffer)
        .resize(targetWidth, targetHeight, { kernel: 'lanczos3' })
        .sharpen({ sigma: 1.2 })
        .normalize()
        .jpeg({ quality: 92, mozjpeg: true })
        .toBuffer();
}

module.exports = {
    isFfmpegAvailable,
    videoToAudio,
    audioToVoiceNote,
    imageToVideo,
    animatedStickerToVideo,
    convertAudioFormat,
    gifToVideo,
    videoToGif,
    animatedStickerToGif,
    reverseVideo,
    reverseAudio,
    renameMediaMetadata,
    compressVideo,
    compressImage,
    enhanceImage
};
