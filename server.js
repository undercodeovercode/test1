const express = require('express');
const app = express();
const PORT = 3000;

app.use(express.static('.'));

/*
 * GET /api/captions/:videoId
 * → { title, tracks: [{ label, languageCode, kind, baseUrl }] }
 *
 * 왜 InnerTube API를 쓰는가:
 *   YouTube 페이지 HTML(500KB+)을 파싱하는 것보다
 *   InnerTube Player API(JSON 응답)가 가볍고, 봇 감지에 강하며,
 *   captionTracks를 구조화된 JSON으로 바로 받을 수 있다.
 */
app.get('/api/captions/:videoId', async (req, res) => {
    const { videoId } = req.params;

    try {
        const result = await fetchViaInnerTube(videoId);
        if (result && result.tracks.length > 0) return res.json(result);

        // 폴백: YouTube 페이지 파싱 (InnerTube 실패 시)
        const result2 = await fetchViaPageParse(videoId);
        if (result2) return res.json(result2);

        res.json({ title: '', tracks: [] });
    } catch (err) {
        console.error('자막 목록 가져오기 실패:', err.message);
        res.status(500).json({ error: err.message });
    }
});

/*
 * GET /api/subtitle?url=BASE_URL
 * → [{ start, dur, text }, ...]
 *
 * 왜 서버에서 파싱하는가:
 *   InnerTube baseUrl은 기본적으로 srv3 형식(<p t="" d="">)을 반환하고,
 *   일부는 srv1 형식(<text start="" dur="">)이나 json3를 반환한다.
 *   서버에서 모든 형식을 파싱하고 통일된 JSON 배열로 반환하면
 *   클라이언트는 형식을 신경 쓸 필요 없이 렌더링만 하면 된다.
 */
app.get('/api/subtitle', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url 파라미터 필요' });

    try {
        // json3 형식을 요청 — 가장 파싱하기 쉽고 정보가 풍부한 형식
        const json3Url = replaceUrlParam(url, 'fmt', 'json3');
        const subtitles = await fetchAndParseJson3(json3Url);

        if (subtitles.length > 0) {
            return res.json(subtitles);
        }

        // json3 실패 시 원본 URL(srv3 XML)로 폴백
        const fallbackSubs = await fetchAndParseXml(url);
        res.json(fallbackSubs);
    } catch (err) {
        console.error('자막 내용 가져오기 실패:', err.message);
        res.status(500).json({ error: err.message });
    }
});

/*
 * json3 형식 파싱
 *
 * 왜 json3를 우선 사용하는가:
 *   YouTube의 json3 형식은 자막 데이터를 구조화된 JSON으로 제공한다.
 *   events[].segs[].utf8 에 텍스트가 있고,
 *   events[].tStartMs / dDurationMs 에 타이밍이 있다.
 *   XML 파싱보다 안정적이고, 줄바꿈/특수문자 처리가 쉽다.
 */
async function fetchAndParseJson3(url) {
    const resp = await fetch(url);
    if (!resp.ok) return [];

    const data = await resp.json();
    if (!data.events) return [];

    const subtitles = [];
    for (const event of data.events) {
        // segs가 없는 이벤트는 줄바꿈/스타일 전용이므로 건너뜀
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
}

/*
 * XML 형식 파싱 (srv1 <text> 및 srv3 <p> 모두 지원)
 *
 * 폴백용으로, json3 요청이 실패했을 때만 사용된다.
 * srv1: <text start="초" dur="초">내용</text>
 * srv3: <p t="밀리초" d="밀리초">내용</p>
 */
async function fetchAndParseXml(url) {
    const resp = await fetch(url);
    if (!resp.ok) return [];

    const xml = await resp.text();
    const subtitles = [];

    // srv1 형식: <text start="1.23" dur="4.56">
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

    // srv3 형식: <p t="1230" d="4560">
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
}

/* URL의 쿼리 파라미터를 교체하는 헬퍼 */
function replaceUrlParam(url, param, value) {
    const u = new URL(url);
    u.searchParams.set(param, value);
    return u.toString();
}

/* XML 엔티티 디코딩 */
function decodeXmlEntities(str) {
    return str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/<[^>]*>/g, ''); // 인라인 태그 제거 (<font> 등)
}

/* ── InnerTube Player API ── */
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

    return {
        title,
        tracks: captionTracks.map(t => ({
            label: t.name?.simpleText || t.languageCode,
            languageCode: t.languageCode,
            kind: t.kind || '',
            baseUrl: t.baseUrl,
        })),
    };
}

/* ── YouTube 페이지 파싱 (폴백) ── */
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

app.listen(PORT, () => {
    console.log(`유튜브 자막 추출기 실행 중: http://localhost:${PORT}`);
});
