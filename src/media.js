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

module.exports = {
    isFfmpegAvailable,
    videoToAudio,
    audioToVoiceNote,
    imageToVideo
};
