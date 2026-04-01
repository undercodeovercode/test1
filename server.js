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
 * 세션 쿠키 저장소.
 * YouTube 페이지를 요청하면 Set-Cookie로 세션 쿠키를 내려준다.
 * 이 쿠키가 없으면 timedtext URL 요청 시 빈 응답(0바이트)이 온다.
 * 브라우저에서는 같은 도메인 쿠키가 자동 공유되지만
 * Node.js fetch()는 요청마다 독립적이므로 수동으로 관리해야 한다.
 */
let sessionCookies = '';

app.get('/api/captions/:videoId', async (req, res) => {
    const { videoId } = req.params;

    try {
        console.log(`\n===== 자막 목록 요청: ${videoId} =====`);

        const resp = await fetch(
            `https://www.youtube.com/watch?v=${videoId}`,
            { headers: BROWSER_HEADERS },
        );

        // YouTube가 보낸 Set-Cookie 헤더를 저장
        const setCookies = resp.headers.getSetCookie?.() || [];
        if (setCookies.length > 0) {
            sessionCookies = setCookies
                .map(c => c.split(';')[0])  // 쿠키 이름=값 부분만 추출
                .join('; ');
            console.log('세션 쿠키 저장:', sessionCookies.substring(0, 100) + '...');
        }

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
            const url = t.baseUrl || '';
            console.log(`  [${i}] ${t.languageCode} (${t.kind || 'manual'})`);
            console.log(`      URL 처음 120자: ${url.substring(0, 120)}`);
            return {
                label: t.name?.simpleText || t.languageCode,
                languageCode: t.languageCode,
                kind: t.kind || '',
                baseUrl: url,
            };
        });

        res.json({ title, tracks });
    } catch (err) {
        console.error('자막 목록 실패:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/subtitle', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url 파라미터 필요' });

    try {
        console.log(`\n===== 자막 내용 요청 =====`);
        console.log('요청 URL 처음 150자:', url.substring(0, 150));

        // 세션 쿠키를 포함한 헤더
        const headers = { ...BROWSER_HEADERS };
        if (sessionCookies) {
            headers.Cookie = sessionCookies + '; CONSENT=PENDING+987';
        }
        console.log('쿠키:', headers.Cookie?.substring(0, 80) + '...');

        // 1순위: json3
        const json3Url = setUrlParam(url, 'fmt', 'json3');
        console.log('[1] json3 시도');
        let subs = await fetchSubtitle(json3Url, headers, 'json3');
        if (subs.length > 0) return res.json(subs);

        // 2순위: 원본 baseUrl
        console.log('[2] 원본 URL 시도');
        subs = await fetchSubtitle(url, headers, 'xml');
        if (subs.length > 0) return res.json(subs);

        console.log('모든 형식 실패');
        res.json([]);
    } catch (err) {
        console.error('자막 내용 실패:', err.message);
        res.status(500).json({ error: err.message });
    }
});

async function fetchSubtitle(url, headers, mode) {
    try {
        const resp = await fetch(url, { headers });
        console.log(`  HTTP ${resp.status}, Content-Type: ${resp.headers.get('content-type')}`);
        if (!resp.ok) return [];

        const raw = await resp.text();
        console.log(`  응답: ${raw.length}바이트`);
        if (raw.length > 0) {
            console.log(`  처음 200자: ${raw.substring(0, 200)}`);
        }
        if (!raw || raw.length === 0) return [];

        if (mode === 'json3') {
            return parseJson3(raw);
        } else {
            return parseXml(raw);
        }
    } catch (err) {
        console.log(`  요청 실패: ${err.message}`);
        return [];
    }
}

function parseJson3(raw) {
    try {
        if (!raw.trim().startsWith('{')) return [];
        const data = JSON.parse(raw);
        if (!data.events) return [];
        const subs = [];
        for (const ev of data.events) {
            if (!ev.segs) continue;
            const text = ev.segs.map(s => s.utf8 || '').join('').trim();
            if (!text || text === '\n') continue;
            subs.push({ start: (ev.tStartMs || 0) / 1000, dur: (ev.dDurationMs || 0) / 1000, text });
        }
        return subs;
    } catch (_) { return []; }
}

function parseXml(xml) {
    const subs = [];
    // srv1: <text start="" dur="">
    let m, re = /<text[^>]*start="([^"]*)"[^>]*dur="([^"]*)"[^>]*>([\s\S]*?)<\/text>/g;
    while ((m = re.exec(xml)) !== null) {
        const t = decodeXml(m[3]).trim();
        if (t) subs.push({ start: +m[1] || 0, dur: +m[2] || 0, text: t });
    }
    if (subs.length > 0) return subs;

    // srv3: <p t="" d="">
    re = /<p[^>]*t="([^"]*)"[^>]*d="([^"]*)"[^>]*>([\s\S]*?)<\/p>/g;
    while ((m = re.exec(xml)) !== null) {
        const t = decodeXml(m[3]).trim();
        if (t) subs.push({ start: (+m[1] || 0) / 1000, dur: (+m[2] || 0) / 1000, text: t });
    }
    return subs;
}

function setUrlParam(url, key, val) {
    try {
        const u = new URL(url);
        u.searchParams.set(key, val);
        return u.toString();
    } catch (_) {
        // 상대 URL이면 도메인 붙이기
        const full = url.startsWith('/') ? 'https://www.youtube.com' + url : url;
        const u = new URL(full);
        u.searchParams.set(key, val);
        return u.toString();
    }
}

function decodeXml(s) {
    return s
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/<[^>]*>/g, '');
}

app.listen(PORT, () => {
    console.log(`유튜브 자막 추출기 실행 중: http://localhost:${PORT}`);
});
