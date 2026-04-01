const express = require('express');
const app = express();
const PORT = 3000;

app.use(express.static('.'));

// 자막 트랙 목록 가져오기
app.get('/api/captions/:videoId', async (req, res) => {
    const { videoId } = req.params;

    try {
        // YouTube 페이지에서 captionTracks 추출
        const pageResp = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'ko,en;q=0.9',
            },
        });
        const html = await pageResp.text();

        // 제목 추출
        const titleMatch = html.match(/<title>(.*?)<\/title>/);
        const title = titleMatch
            ? titleMatch[1].replace(/ - YouTube$/, '').trim()
            : '';

        // captionTracks JSON 추출
        const startIdx = html.indexOf('"captionTracks":');
        if (startIdx === -1) {
            return res.json({ title, tracks: [], error: '자막 없음' });
        }

        const bracketStart = html.indexOf('[', startIdx);
        let depth = 0;
        let bracketEnd = bracketStart;
        for (let i = bracketStart; i < html.length; i++) {
            if (html[i] === '[') depth++;
            if (html[i] === ']') depth--;
            if (depth === 0) { bracketEnd = i + 1; break; }
        }

        const tracks = JSON.parse(html.substring(bracketStart, bracketEnd));
        const result = tracks.map(t => ({
            label: t.name?.simpleText || t.languageCode,
            languageCode: t.languageCode,
            kind: t.kind || '',
            baseUrl: t.baseUrl,
        }));

        res.json({ title, tracks: result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

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
