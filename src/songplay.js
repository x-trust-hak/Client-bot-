// songplay.js — Lady Liya .play command backend
//
// Searches YouTube for a track by name (yt-search) and pulls an
// audio-only stream (@distube/ytdl-core), converting it to mp3 via the
// same ffmpeg-static + fluent-ffmpeg setup media.js already uses —
// lazy-required so a missing/broken install fails cleanly.
//
// HONEST CAVEAT: this is the least stable command type in the project.
// YouTube actively fights scraping/downloading tools, so ytdl-core
// periodically breaks until it's updated upstream. If .play stops
// working, check for a newer @distube/ytdl-core release first — that's
// almost always the fix. This could not be network-tested from the
// sandbox this was written in (no outbound network access there).

const MAX_DURATION_SECONDS = 15 * 60; // safety cap against huge/abusive downloads

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

async function searchSong(query) {
    let ytSearch;
    try {
        ytSearch = require('yt-search');
    } catch {
        throw new Error('yt-search is not installed — run npm install after pulling this update.');
    }

    const results = await ytSearch(query);
    const video = (results.videos || [])[0];
    if (!video) return null;

    return {
        title: video.title,
        url: video.url,
        durationSeconds: video.seconds,
        durationText: video.timestamp,
        views: video.views,
        author: video.author?.name || 'Unknown',
        thumbnail: video.thumbnail
    };
}

async function downloadAudioMp3(url) {
    let ytdl;
    try {
        ytdl = require('@distube/ytdl-core');
    } catch {
        throw new Error('@distube/ytdl-core is not installed — run npm install after pulling this update.');
    }

    if (!isFfmpegAvailable()) {
        throw new Error('FFMPEG_NOT_INSTALLED');
    }

    let ffmpeg;
    try {
        ffmpeg = require('fluent-ffmpeg');
    } catch {
        throw new Error('FFMPEG_NOT_INSTALLED');
    }
    ffmpeg.setFfmpegPath(getFfmpegPath());

    const info = await ytdl.getInfo(url);
    const durationSeconds = parseInt(info.videoDetails.lengthSeconds || '0', 10);
    if (durationSeconds > MAX_DURATION_SECONDS) {
        throw new Error(`Track is too long (${Math.round(durationSeconds / 60)} min) — max is ${MAX_DURATION_SECONDS / 60} min.`);
    }

    const audioStream = ytdl.downloadFromInfo(info, { filter: 'audioonly', quality: 'highestaudio' });

    return new Promise((resolve, reject) => {
        const chunks = [];
        const command = ffmpeg(audioStream)
            .audioBitrate(128)
            .format('mp3')
            .on('error', reject)
            .on('end', () => resolve(Buffer.concat(chunks)));

        const stream = command.pipe();
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('error', reject);
    });
}

module.exports = {
    isFfmpegAvailable,
    searchSong,
    downloadAudioMp3,
    MAX_DURATION_SECONDS
};
