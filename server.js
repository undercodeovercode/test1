const express = require('express');
const app = express();
const PORT = 3000;

app.use(express.static('.'));

/*
 * YouTube 요청에 사용할 브라우저 헤더.
 * 헤더 없이 요청하면 YouTube가 봇으로 인식하여 빈 응답(0바이트)을 반환한다.
 * User-Agent + Accept-Language + Cookie(CONSENT)를 설정하면
 * 일반 브라우저 요청과 동일하게 취급된다.
 */
const BROWSER_HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept-Language': 'ko,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    Cookie: 'CONSENT=PENDING+987',
};

/*
 * GET /api/captions/:videoId
 *
 * InnerTube Player API로 자막 트랙 목록을 가져온다.
 * baseUrl은 서명이 ip=0.0.0.0으로 되어있어 직접 사용할 수 없으므로,
 * 클라이언트에는 languageCode와 kind만 전달한다.
 * 실제 자막 내용은 /api/subtitle 에서 서버가 URL을 직접 구성하여 가져온다.
 */
app.get('/api/captions/:videoId', async (req, res) => {
    const { videoId } = req.params;

    try {
        const result = await fetchViaInnerTube(videoId);
        if (result && result.tracks.length > 0) return res.json(result);

        const result2 = await fetchViaPageParse(videoId);
        if (result2) return res.json(result2);

        res.json({ title: '', tracks: [] });
    } catch (err) {
        console.error('자막 목록 가져오기 실패:', err.message);
        res.status(500).json({ error: err.message });
    }
});

/*
 * GET /api/subtitle/:videoId?lang=xx&kind=asr&name=xx
 *
 * 왜 baseUrl을 안 쓰고 직접 URL을 구성하는가:
 *   InnerTube가 반환하는 baseUrl은 ip=0.0.0.0 + signature로 서명되어 있다.
 *   이 서명은 InnerTube API 호출 시점의 컨텍스트에 묶여있어서,
 *   서버가 별도로 이 URL을 요청하면 서명 불일치로 빈 응답(0바이트)이 온다.
 *
 *   대신 서버가 직접 timedtext URL을 구성하면,
 *   YouTube는 서명 없이도 자막을 반환한다.
 */
app.get('/api/subtitle/:videoId', async (req, res) => {
    const { videoId } = req.params;
    const { lang, kind, name } = req.query;

    try {
        // 서버에서 직접 URL 구성 (서명 불필요)
        const params = new URLSearchParams({ v: videoId, lang: lang || 'en' });
        if (kind) params.set('kind', kind);
        if (name) params.set('name', name);

        console.log(`\n===== 자막 요청: ${videoId} lang=${lang} kind=${kind || '없음'} =====`);

        // 1순위: json3 형식 (구조화된 JSON)
        params.set('fmt', 'json3');
        const json3Url = `https://www.youtube.com/api/timedtext?${params}`;
        console.log('[1] json3 요청:', json3Url);

        let subtitles = await fetchAndParseJson3(json3Url);
        if (subtitles.length > 0) {
            console.log(`[1] 성공: ${subtitles.length}개`);
            return res.json(subtitles);
        }

        // 2순위: srv1 XML 형식
        params.set('fmt', 'srv1');
        const srv1Url = `https://www.youtube.com/api/timedtext?${params}`;
        console.log('[2] srv1 요청:', srv1Url);

        subtitles = await fetchAndParseXml(srv1Url);
        if (subtitles.length > 0) {
            console.log(`[2] 성공: ${subtitles.length}개`);
            return res.json(subtitles);
        }

        // 3순위: 기본 형식 (fmt 파라미터 없이)
        params.delete('fmt');
        const defaultUrl = `https://www.youtube.com/api/timedtext?${params}`;
        console.log('[3] 기본 요청:', defaultUrl);

        subtitles = await fetchAndParseXml(defaultUrl);
        console.log(`[3] 결과: ${subtitles.length}개`);
        res.json(subtitles);

    } catch (err) {
        console.error('자막 내용 가져오기 실패:', err.message);
        res.status(500).json({ error: err.message });
    }
});

/* ── json3 파싱 ── */
async function fetchAndParseJson3(url) {
    try {
        const resp = await fetch(url, { headers: BROWSER_HEADERS });
        if (!resp.ok) return [];

        const raw = await resp.text();
        console.log(`  응답: ${raw.length}바이트`);
        if (!raw || !raw.trim().startsWith('{')) return [];

        const data = JSON.parse(raw);
        if (!data.events) return [];

        const subtitles = [];
        for (const event of data.events) {
            if (!event.segs) continue;
            const text = event.segs.map(s => s.utf8 || '').join('').trim();
            if (!text || text === '\n') continue;
            subtitles.push({
                start: (event.tStartMs || 0) / 1000,
                dur: (event.dDurationMs || 0) / 1000,
                text,
            });
        }
        return subtitles;
    } catch (err) {
        console.log('  json3 파싱 실패:', err.message);
        return [];
    }
}

/* ── XML 파싱 (srv1 <text> + srv3 <p>) ── */
async function fetchAndParseXml(url) {
    try {
        const resp = await fetch(url, { headers: BROWSER_HEADERS });
        if (!resp.ok) return [];

        const xml = await resp.text();
        console.log(`  응답: ${xml.length}바이트, 처음 200자: ${xml.substring(0, 200)}`);
        const subtitles = [];

        // srv1: <text start="초" dur="초">
        const textRegex = /<text[^>]*start="([^"]*)"[^>]*dur="([^"]*)"[^>]*>([\s\S]*?)<\/text>/g;
        let match;
        while ((match = textRegex.exec(xml)) !== null) {
            const text = decodeXmlEntities(match[3]).trim();
            if (text) {
                subtitles.push({
                    start: parseFloat(match[1]) || 0,
                    dur: parseFloat(match[2]) || 0,
                    text,
                });
            }
        }
        if (subtitles.length > 0) return subtitles;

        // srv3: <p t="밀리초" d="밀리초">
        const pRegex = /<p[^>]*t="([^"]*)"[^>]*d="([^"]*)"[^>]*>([\s\S]*?)<\/p>/g;
        while ((match = pRegex.exec(xml)) !== null) {
            const text = decodeXmlEntities(match[3]).trim();
            if (text) {
                subtitles.push({
                    start: (parseFloat(match[1]) || 0) / 1000,
                    dur: (parseFloat(match[2]) || 0) / 1000,
                    text,
                });
            }
        }
        return subtitles;
    } catch (err) {
        console.log('  XML 파싱 실패:', err.message);
        return [];
    }
}

/* ── 유틸리티 ── */
function decodeXmlEntities(str) {
    return str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/<[^>]*>/g, '');
}

/* ── InnerTube Player API ── */
async function fetchViaInnerTube(videoId) {
    const resp = await fetch('https://www.youtube.com/youtubei/v1/player', {
        method: 'POST',
        headers: { ...BROWSER_HEADERS, 'Content-Type': 'application/json' },
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

    return {
        title,
        tracks: captionTracks.map(t => ({
            label: t.name?.simpleText || t.languageCode,
            languageCode: t.languageCode,
            kind: t.kind || '',
        })),
    };
}

/* ── YouTube 페이지 파싱 (폴백) ── */
async function fetchViaPageParse(videoId) {
    const resp = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
        headers: BROWSER_HEADERS,
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
        }),
    );

    return { title, tracks };
}

app.listen(PORT, () => {
    console.log(`유튜브 자막 추출기 실행 중: http://localhost:${PORT}`);
});
