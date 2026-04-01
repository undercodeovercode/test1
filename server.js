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
        console.log('\n===== 자막 요청 시작 =====');
        console.log('원본 baseUrl:', url);

        // json3 형식을 요청
        const json3Url = replaceUrlParam(url, 'fmt', 'json3');
        console.log('\n[1단계] json3 URL:', json3Url);
        const subtitles = await fetchAndParseJson3(json3Url);
        console.log('[1단계] json3 파싱 결과:', subtitles.length, '개');

        if (subtitles.length > 0) {
            return res.json(subtitles);
        }

        // json3 실패 시 원본 URL(srv3 XML)로 폴백
        console.log('\n[2단계] XML 폴백 시도, URL:', url);
        const fallbackSubs = await fetchAndParseXml(url);
        console.log('[2단계] XML 파싱 결과:', fallbackSubs.length, '개');
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
 *
 * 왜 try/catch로 감싸는가:
 *   YouTube가 fmt=json3 요청에 대해 항상 JSON을 반환하지 않는다.
 *   HTML 에러 페이지, 빈 응답 등을 반환할 수 있으므로,
 *   파싱 실패 시 빈 배열을 반환하여 XML 폴백이 실행되게 한다.
 */
async function fetchAndParseJson3(url) {
    try {
        const resp = await fetch(url);
        console.log('  json3 HTTP 상태:', resp.status);
        if (!resp.ok) return [];

        const raw = await resp.text();
        console.log('  json3 응답 길이:', raw.length, '바이트');
        console.log('  json3 응답 처음 500자:', raw.substring(0, 500));
        if (!raw || !raw.trim().startsWith('{')) {
            console.log('  json3 응답이 JSON이 아님, 건너뜀');
            return [];
        }

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
        // json3 파싱 실패는 치명적이지 않음 — XML 폴백으로 넘어감
        console.log('json3 파싱 실패 (XML 폴백 시도):', err.message);
        return [];
    }
}

/*
 * XML 형식 파싱 (srv1 <text> 및 srv3 <p> 모두 지원)
 *
 * json3 요청이 실패했을 때 사용되는 폴백.
 * srv1: <text start="초" dur="초">내용</text>
 * srv3: <p t="밀리초" d="밀리초">내용</p>
 *
 * 왜 try/catch로 감싸는가:
 *   네트워크 오류나 YouTube의 예상치 못한 응답 형식에 대해
 *   빈 배열을 반환하여 클라이언트에 "자막이 비어 있습니다" 표시.
 */
async function fetchAndParseXml(url) {
    try {
        const resp = await fetch(url);
        console.log('  XML HTTP 상태:', resp.status);
        if (!resp.ok) return [];

        const xml = await resp.text();
        console.log('  XML 응답 길이:', xml.length, '바이트');
        console.log('  XML 응답 처음 500자:', xml.substring(0, 500));
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
    } catch (err) {
        console.log('XML 파싱 실패:', err.message);
        return [];
    }
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
