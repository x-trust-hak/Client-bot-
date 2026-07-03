// livedata.js — Lady Liya Live Data Lookups
//
// IMPORTANT: these hit real external APIs at runtime and could not be
// network-tested from the sandbox this was written in (no outbound
// network access there). All three use free, keyless, well-established
// public endpoints and the request/response shapes are written to match
// their documented contracts, but please smoke-test each one after
// deploying — like anything hitting a third-party service, they can
// change or rate-limit without notice.
//
//   .wiki    -> Wikipedia REST API summary endpoint (no key)
//   .npminfo -> npm registry API (no key)
//   .news    -> BBC News RSS feed, parsed with a small regex parser
//               (no XML library dependency, no key)

const axios = require('axios');

async function wikiSummary(query) {
    const title = encodeURIComponent(query.trim().replace(/\s+/g, '_'));
    const res = await axios.get(`https://en.wikipedia.org/api/rest_v1/page/summary/${title}`, {
        timeout: 10000,
        headers: { 'User-Agent': 'LadyLiyaBot/1.0' },
        validateStatus: () => true
    });

    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error(`Wikipedia API returned ${res.status}`);

    const data = res.data;
    if (data.type === 'disambiguation') {
        return { disambiguation: true, title: data.title };
    }

    return {
        title: data.title,
        extract: data.extract,
        url: data.content_urls?.desktop?.page || null,
        thumbnail: data.thumbnail?.source || null
    };
}

async function npmPackageInfo(pkgName) {
    const res = await axios.get(`https://registry.npmjs.org/${encodeURIComponent(pkgName)}`, {
        timeout: 10000,
        validateStatus: () => true
    });

    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error(`npm registry returned ${res.status}`);

    const data = res.data;
    const latest = data['dist-tags']?.latest;
    const latestInfo = latest ? data.versions?.[latest] : null;

    return {
        name: data.name,
        version: latest || 'unknown',
        description: data.description || '(no description)',
        license: latestInfo?.license || data.license || 'unknown',
        homepage: data.homepage || null,
        author: (typeof data.author === 'object' ? data.author?.name : data.author) || null,
        lastPublished: data.time?.[latest] || null
    };
}

// Small regex-based RSS <item> extractor — avoids pulling in a whole XML
// parser dependency for something this simple. RSS 2.0 item blocks are
// very regular in practice; this covers the common case (title + link),
// not the full spec.
function parseRssItems(xml, limit = 5) {
    const items = [];
    const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/g) || [];
    for (const block of itemBlocks.slice(0, limit)) {
        const titleMatch = block.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/s);
        const linkMatch = block.match(/<link>(.*?)<\/link>/s);
        if (titleMatch) {
            items.push({
                title: titleMatch[1].trim(),
                link: linkMatch ? linkMatch[1].trim() : null
            });
        }
    }
    return items;
}

async function fetchNewsHeadlines(limit = 5) {
    const res = await axios.get('https://feeds.bbci.co.uk/news/rss.xml', {
        timeout: 10000,
        headers: { 'User-Agent': 'LadyLiyaBot/1.0' },
        validateStatus: () => true
    });

    if (res.status !== 200) throw new Error(`News feed returned ${res.status}`);
    return parseRssItems(typeof res.data === 'string' ? res.data : String(res.data), limit);
}

module.exports = {
    wikiSummary,
    npmPackageInfo,
    parseRssItems,
    fetchNewsHeadlines
};
