import express from 'express';

const app = express();
const PORT = 3000;

app.use(express.static('.'));

/*
 * youtube-transcript 패키지의 핵심 로직을 직접 구현.
 * (패키지 자체가 CJS/ESM 빌드 버그로 Node v24에서 로드 불가)
 *
 * 핵심: ANDROID 클라이언트로 InnerTube Player API를 호출하면
 * WEB 클라이언트와 달리 ip=0.0.0.0 서명 문제가 없는 baseUrl을 받는다.
 */

const INNERTUBE_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const ANDROID_VERSION = '20.10.38';
const ANDROID_CONTEXT = {
    client: { clientName: 'ANDROID', clientVersion: ANDROID_VERSION },
};
const ANDROID_UA = `com.google.android.youtube/${ANDROID_VERSION} (Linux; U; Android 14)`;
const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

app.get('/api/captions/:videoId', async (req, res) => {
    const { videoId } = req.params;
    const lang = req.query.lang || undefined;

    try {
        console.log(`\n===== 자막 요청: ${videoId} lang=${lang || '기본'} =====`);

        // 1단계: ANDROID 클라이언트로 InnerTube Player API 호출 → captionTracks 획득
        let tracks = await getCaptionTracks(videoId);

        // ANDROID 실패 시 웹 페이지 파싱 폴백
        if (!tracks || tracks.length === 0) {
            console.log('ANDROID InnerTube 실패, 웹 페이지 파싱 시도');
            tracks = await getCaptionTracksFromPage(videoId);
        }

        if (!tracks || tracks.length === 0) {
            return res.json({ subtitles: [], error: '자막이 없습니다.' });
        }

        console.log(`트랙 ${tracks.length}개:`, tracks.map(t => t.languageCode).join(', '));

        // 언어 선택
        const track = lang
            ? tracks.find(t => t.languageCode === lang) || tracks[0]
            : tracks[0];

        console.log(`선택된 트랙: ${track.languageCode}`);
        console.log(`baseUrl 처음 120자: ${track.baseUrl.substring(0, 120)}`);

        // 2단계: baseUrl로 자막 XML 가져오기
        const subtitleResp = await fetch(track.baseUrl, {
            headers: { 'User-Agent': WEB_UA },
        });
        const xml = await subtitleResp.text();
        console.log(`자막 응답: ${xml.length}바이트`);

        if (!xml || xml.length === 0) {
            return res.json({ subtitles: [], error: '자막 내용이 비어있습니다.' });
        }

        // 3단계: XML 파싱
        const subtitles = parseSubtitleXml(xml, track.languageCode);
        console.log(`파싱 결과: ${subtitles.length}개`);

        // 사용 가능한 언어 목록도 함께 반환
        const languages = tracks.map(t => ({
            code: t.languageCode,
            label: t.label || t.languageCode,
            kind: t.kind || '',
        }));

        res.json({ subtitles, languages });
    } catch (err) {
        console.error('오류:', err.message);
        res.status(500).json({ error: err.message, subtitles: [] });
    }
});

/* ANDROID 클라이언트로 InnerTube 호출 */
async function getCaptionTracks(videoId) {
    try {
        const resp = await fetch(INNERTUBE_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': ANDROID_UA,
            },
            body: JSON.stringify({ context: ANDROID_CONTEXT, videoId }),
        });
        if (!resp.ok) return null;

        const data = await resp.json();
        const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
        if (!Array.isArray(tracks) || tracks.length === 0) return null;

        return tracks.map(t => ({
            baseUrl: t.baseUrl,
            languageCode: t.languageCode,
            label: t.name?.simpleText || t.languageCode,
            kind: t.kind || '',
        }));
    } catch (err) {
        console.log('InnerTube 실패:', err.message);
        return null;
    }
}

/* 웹 페이지 파싱 폴백 */
async function getCaptionTracksFromPage(videoId) {
    try {
        const resp = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
            headers: { 'User-Agent': WEB_UA, Cookie: 'CONSENT=PENDING+987' },
        });
        const html = await resp.text();

        const idx = html.indexOf('"captionTracks":');
        if (idx === -1) return null;

        const start = html.indexOf('[', idx);
        let depth = 0, end = start;
        for (let i = start; i < html.length; i++) {
            if (html[i] === '[') depth++;
            if (html[i] === ']') depth--;
            if (depth === 0) { end = i + 1; break; }
        }

        return JSON.parse(html.substring(start, end)).map(t => ({
            baseUrl: t.baseUrl,
            languageCode: t.languageCode,
            label: t.name?.simpleText || t.languageCode,
            kind: t.kind || '',
        }));
    } catch (err) {
        console.log('페이지 파싱 실패:', err.message);
        return null;
    }
}

/* 자막 XML 파싱 — srv3 <p t="" d=""> 및 srv1 <text start="" dur=""> 지원 */
function parseSubtitleXml(xml, lang) {
    const subs = [];

    // srv3: <p t="밀리초" d="밀리초">
    const pRegex = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
    let m;
    while ((m = pRegex.exec(xml)) !== null) {
        let text = '';
        // <s> 태그 안의 텍스트 추출
        const sRegex = /<s[^>]*>([^<]*)<\/s>/g;
        let sm;
        while ((sm = sRegex.exec(m[3])) !== null) text += sm[1];
        // <s> 태그 없으면 태그 제거 후 사용
        if (!text) text = m[3].replace(/<[^>]+>/g, '');
        text = decodeEntities(text).trim();
        if (text) {
            subs.push({
                start: parseInt(m[1], 10) / 1000,
                dur: parseInt(m[2], 10) / 1000,
                text,
            });
        }
    }
    if (subs.length > 0) return subs;

    // srv1: <text start="초" dur="초">
    const textRegex = /<text start="([^"]*)" dur="([^"]*)">([^<]*)<\/text>/g;
    while ((m = textRegex.exec(xml)) !== null) {
        const text = decodeEntities(m[3]).trim();
        if (text) {
            subs.push({
                start: parseFloat(m[1]),
                dur: parseFloat(m[2]),
                text,
            });
        }
    }
    return subs;
}

function decodeEntities(s) {
    return s
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

/* 영상 제목 (oEmbed) */
app.get('/api/title/:videoId', async (req, res) => {
    try {
        const r = await fetch(
            `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${req.params.videoId}&format=json`,
        );
        if (r.ok) {
            const d = await r.json();
            return res.json({ title: d.title || '' });
        }
        res.json({ title: '' });
    } catch (_) { res.json({ title: '' }); }
});

app.listen(PORT, () => {
    console.log(`유튜브 자막 추출기 실행 중: http://localhost:${PORT}`);
});
