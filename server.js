const express = require('express');
const app = express();
const PORT = 3000;

app.use(express.static('.'));

// YouTube InnerTube API로 자막 트랙 목록 가져오기
app.get('/api/captions/:videoId', async (req, res) => {
    const { videoId } = req.params;

    try {
        // 방법 1: InnerTube Player API (가장 안정적)
        const result = await fetchViaInnerTube(videoId);
        if (result) return res.json(result);

        // 방법 2: YouTube 페이지 파싱 (폴백)
        const result2 = await fetchViaPageParse(videoId);
        if (result2) return res.json(result2);

        res.json({ title: '', tracks: [] });
    } catch (err) {
        console.error('자막 가져오기 실패:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// InnerTube Player API
async function fetchViaInnerTube(videoId) {
    const resp = await fetch('https://www.youtube.com/youtubei/v1/player', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            context: {
                client: {
                    clientName: 'WEB',
                    clientVersion: '2.20241126.01.00',
                    hl: 'ko',
                },
            },
            videoId,
        }),
    });

    if (!resp.ok) return null;
    const data = await resp.json();

    const title = data.videoDetails?.title || '';
    const captionTracks =
        data.captions?.playerCaptionsTracklistRenderer?.captionTracks;

    if (!captionTracks || captionTracks.length === 0) return null;

    const tracks = captionTracks.map(t => ({
        label: t.name?.simpleText || t.languageCode,
        languageCode: t.languageCode,
        kind: t.kind || '',
        baseUrl: t.baseUrl,
    }));

    return { title, tracks };
}

// YouTube 페이지 HTML 파싱 (폴백)
async function fetchViaPageParse(videoId) {
    const resp = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
        headers: {
            'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept-Language': 'ko,en;q=0.9',
            Cookie: 'CONSENT=PENDING+987',
        },
    });

    const html = await resp.text();

    const titleMatch = html.match(/<title>(.*?)<\/title>/);
    const title = titleMatch
        ? titleMatch[1].replace(/ - YouTube$/, '').trim()
        : '';

    const startIdx = html.indexOf('"captionTracks":');
    if (startIdx === -1) return { title, tracks: [] };

    const bracketStart = html.indexOf('[', startIdx);
    let depth = 0, bracketEnd = bracketStart;
    for (let i = bracketStart; i < html.length; i++) {
        if (html[i] === '[') depth++;
        if (html[i] === ']') depth--;
        if (depth === 0) { bracketEnd = i + 1; break; }
    }

    const tracks = JSON.parse(html.substring(bracketStart, bracketEnd)).map(
        t => ({
            label: t.name?.simpleText || t.languageCode,
            languageCode: t.languageCode,
            kind: t.kind || '',
            baseUrl: t.baseUrl,
        }),
    );

    return { title, tracks };
}

// 자막 XML 프록시
app.get('/api/subtitle', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).send('url 파라미터 필요');

    try {
        const resp = await fetch(url);
        const xml = await resp.text();
        res.type('text/xml').send(xml);
    } catch (err) {
        res.status(500).send(err.message);
    }
});

app.listen(PORT, () => {
    console.log(`유튜브 자막 추출기 실행 중: http://localhost:${PORT}`);
});
