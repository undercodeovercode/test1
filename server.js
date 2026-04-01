const express = require('express');
const app = express();
const PORT = 3000;

app.use(express.static('.'));

const BROWSER_HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept-Language': 'ko,en;q=0.9',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    Cookie: 'CONSENT=PENDING+987',
};

/*
 * GET /api/captions/:videoId
 *
 * YouTube 페이지 HTML을 파싱하여 captionTracks를 추출한다.
 * 왜 InnerTube 대신 페이지 파싱을 쓰는가:
 *   InnerTube는 ip=0.0.0.0으로 서명된 baseUrl을 반환하여
 *   서버에서 재요청하면 빈 응답이 온다.
 *   반면 YouTube 페이지를 직접 요청하면,
 *   서버의 실제 IP로 서명된 baseUrl이 포함되어
 *   같은 서버에서 바로 자막을 가져올 수 있다.
 */
app.get('/api/captions/:videoId', async (req, res) => {
    const { videoId } = req.params;

    try {
        console.log(`\n===== 자막 목록 요청: ${videoId} =====`);

        const resp = await fetch(
            `https://www.youtube.com/watch?v=${videoId}`,
            { headers: BROWSER_HEADERS },
        );
        const html = await resp.text();
        console.log(`페이지 크기: ${html.length}바이트`);

        // 제목
        const titleMatch = html.match(/<title>(.*?)<\/title>/);
        const title = titleMatch
            ? titleMatch[1].replace(/ - YouTube$/, '').trim()
            : '';

        // captionTracks 추출
        const startIdx = html.indexOf('"captionTracks":');
        if (startIdx === -1) {
            console.log('captionTracks 없음');
            return res.json({ title, tracks: [] });
        }

        const bracketStart = html.indexOf('[', startIdx);
        let depth = 0, bracketEnd = bracketStart;
        for (let i = bracketStart; i < html.length; i++) {
            if (html[i] === '[') depth++;
            if (html[i] === ']') depth--;
            if (depth === 0) { bracketEnd = i + 1; break; }
        }

        const rawTracks = JSON.parse(html.substring(bracketStart, bracketEnd));
        console.log(`트랙 ${rawTracks.length}개 발견`);

        const tracks = rawTracks.map((t, i) => {
            console.log(`  [${i}] ${t.languageCode} (${t.kind || 'manual'}) baseUrl 길이: ${t.baseUrl?.length || 0}`);
            return {
                label: t.name?.simpleText || t.languageCode,
                languageCode: t.languageCode,
                kind: t.kind || '',
                baseUrl: t.baseUrl,
            };
        });

        res.json({ title, tracks });
    } catch (err) {
        console.error('자막 목록 실패:', err.message);
        res.status(500).json({ error: err.message });
    }
});

/*
 * GET /api/subtitle?url=SIGNED_BASE_URL
 *
 * YouTube 페이지에서 추출한 서명된 baseUrl로 자막을 가져온다.
 * 이 URL은 서버의 IP로 서명되어 있으므로 같은 서버에서 요청하면 작동한다.
 *
 * json3 → srv1 XML → 원본 순으로 시도한다.
 */
app.get('/api/subtitle', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url 파라미터 필요' });

    try {
        console.log(`\n===== 자막 내용 요청 =====`);

        // 1순위: json3
        const json3Url = setUrlParam(url, 'fmt', 'json3');
        console.log('[1] json3 시도');
        let subs = await fetchAndParseJson3(json3Url);
        if (subs.length > 0) {
            console.log(`[1] 성공: ${subs.length}개`);
            return res.json(subs);
        }

        // 2순위: 원본 baseUrl 그대로 (기본 XML 형식)
        console.log('[2] 원본 URL 시도');
        subs = await fetchAndParseXml(url);
        if (subs.length > 0) {
            console.log(`[2] 성공: ${subs.length}개`);
            return res.json(subs);
        }

        console.log('모든 형식 실패, 빈 배열 반환');
        res.json([]);
    } catch (err) {
        console.error('자막 내용 실패:', err.message);
        res.status(500).json({ error: err.message });
    }
});

/* ── json3 파싱 ── */
async function fetchAndParseJson3(url) {
    try {
        const resp = await fetch(url, { headers: BROWSER_HEADERS });
        if (!resp.ok) { console.log(`  HTTP ${resp.status}`); return []; }

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
        console.log('  json3 실패:', err.message);
        return [];
    }
}

/* ── XML 파싱 (srv1 + srv3) ── */
async function fetchAndParseXml(url) {
    try {
        const resp = await fetch(url, { headers: BROWSER_HEADERS });
        if (!resp.ok) { console.log(`  HTTP ${resp.status}`); return []; }

        const xml = await resp.text();
        console.log(`  응답: ${xml.length}바이트, 처음 300자: ${xml.substring(0, 300)}`);
        const subtitles = [];

        // srv1: <text start="초" dur="초">
        const textRegex = /<text[^>]*start="([^"]*)"[^>]*dur="([^"]*)"[^>]*>([\s\S]*?)<\/text>/g;
        let match;
        while ((match = textRegex.exec(xml)) !== null) {
            const text = decodeXml(match[3]).trim();
            if (text) subtitles.push({ start: +match[1] || 0, dur: +match[2] || 0, text });
        }
        if (subtitles.length > 0) return subtitles;

        // srv3: <p t="밀리초" d="밀리초">
        const pRegex = /<p[^>]*t="([^"]*)"[^>]*d="([^"]*)"[^>]*>([\s\S]*?)<\/p>/g;
        while ((match = pRegex.exec(xml)) !== null) {
            const text = decodeXml(match[3]).trim();
            if (text) subtitles.push({ start: (+match[1] || 0) / 1000, dur: (+match[2] || 0) / 1000, text });
        }
        return subtitles;
    } catch (err) {
        console.log('  XML 실패:', err.message);
        return [];
    }
}

function setUrlParam(url, key, val) {
    const u = new URL(url);
    u.searchParams.set(key, val);
    return u.toString();
}

function decodeXml(s) {
    return s
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/<[^>]*>/g, '');
}

app.listen(PORT, () => {
    console.log(`유튜브 자막 추출기 실행 중: http://localhost:${PORT}`);
});
