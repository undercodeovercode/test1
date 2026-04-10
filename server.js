import express from 'express';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');

const app = express();
const PORT = 3000;

app.use(express.static('.'));
app.use(express.json({ limit: '1mb' }));

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

const LANG_NAMES = {
    ko: '한국어',
    en: 'English (영어)',
    ja: '日本語 (일본어)',
    zh: '中文 (중국어)',
    'zh-Hans': '中文简体 (중국어 간체)',
    'zh-Hant': '中文繁體 (중국어 번체)',
    es: 'Español (스페인어)',
    'es-ES': 'Español (스페인어 - 스페인)',
    fr: 'Français (프랑스어)',
    de: 'Deutsch (독일어)',
    it: 'Italiano (이탈리아어)',
    pt: 'Português (포르투갈어)',
    'pt-BR': 'Português (포르투갈어 - 브라질)',
    ru: 'Русский (러시아어)',
    ar: 'العربية (아랍어)',
    hi: 'हिन्दी (힌디어)',
    th: 'ไทย (태국어)',
    vi: 'Tiếng Việt (베트남어)',
    id: 'Bahasa Indonesia (인도네시아어)',
    tr: 'Türkçe (터키어)',
    pl: 'Polski (폴란드어)',
    nl: 'Nederlands (네덜란드어)',
    sv: 'Svenska (스웨덴어)',
    da: 'Dansk (덴마크어)',
    fi: 'Suomi (핀란드어)',
    no: 'Norsk (노르웨이어)',
    uk: 'Українська (우크라이나어)',
    cs: 'Čeština (체코어)',
    ro: 'Română (루마니아어)',
    hu: 'Magyar (헝가리어)',
    el: 'Ελληνικά (그리스어)',
    he: 'עברית (히브리어)',
    km: 'ភាសាខ្មែរ (크메르어)',
    ms: 'Bahasa Melayu (말레이어)',
    tl: 'Filipino (필리핀어)',
    bn: 'বাংলা (벵골어)',
    ta: 'தமிழ் (타밀어)',
    te: 'తెలుగు (텔루구어)',
};

/*
 * 트랙 캐시.
 * 언어를 바꿀 때마다 InnerTube를 다시 호출하면
 * 새 baseUrl의 서명이 달라져서 실패할 수 있다.
 * 첫 요청에서 받은 tracks를 캐시해두면
 * 언어 변경 시 같은 baseUrl을 재사용하여 안정적으로 작동한다.
 */
const tracksCache = new Map();

app.get('/api/captions/:videoId', async (req, res) => {
    const { videoId } = req.params;
    const lang = req.query.lang || undefined;

    try {
        console.log(`\n===== 자막 요청: ${videoId} lang=${lang || '기본'} =====`);

        // 캐시된 tracks가 있으면 재사용 (언어 변경 시 InnerTube 재호출 방지)
        let tracks = tracksCache.get(videoId);

        if (!tracks) {
            tracks = await getCaptionTracks(videoId);
            if (!tracks || tracks.length === 0) {
                console.log('ANDROID InnerTube 실패, 웹 페이지 파싱 시도');
                tracks = await getCaptionTracksFromPage(videoId);
            }
            if (tracks && tracks.length > 0) {
                tracksCache.set(videoId, tracks);
                // 10분 후 캐시 삭제 (baseUrl의 서명은 시간 제한이 있음)
                setTimeout(() => tracksCache.delete(videoId), 10 * 60 * 1000);
            }
        } else {
            console.log('캐시된 트랙 사용');
        }

        if (!tracks || tracks.length === 0) {
            return res.json({ subtitles: [], error: '자막이 없습니다.' });
        }

        console.log(`트랙 ${tracks.length}개:`, tracks.map(t => t.languageCode).join(', '));

        const hasKorean = tracks.some(t => t.languageCode === 'ko');
        const languages = tracks.map(t => ({
            code: t.languageCode,
            label: LANG_NAMES[t.languageCode] || t.label || t.languageCode,
            kind: t.kind || '',
        }));
        if (!hasKorean) {
            languages.unshift({
                code: 'ko',
                label: '한국어 (자동 번역)',
                kind: 'translate',
            });
        }

        // 언어 선택 및 자막 URL 구성
        let fetchUrl;
        if (lang === 'ko' && !hasKorean) {
            fetchUrl = tracks[0].baseUrl + '&tlang=ko';
            console.log('한국어 자동 번역 요청');
            console.log('URL:', fetchUrl.substring(0, 150));
        } else {
            const track = lang
                ? tracks.find(t => t.languageCode === lang) || tracks[0]
                : tracks[0];
            fetchUrl = track.baseUrl;
            console.log(`선택된 트랙: ${track.languageCode}`);
        }

        // 2단계: baseUrl로 자막 XML 가져오기
        const subtitleResp = await fetch(fetchUrl, {
            headers: { 'User-Agent': ANDROID_UA },
        });
        const xml = await subtitleResp.text();
        console.log(`자막 응답: ${xml.length}바이트, HTTP ${subtitleResp.status}`);

        if (subtitleResp.status === 429) {
            return res.json({
                subtitles: [],
                error: 'YouTube 요청 제한에 걸렸습니다. 1~2분 후 다시 시도해주세요.',
            });
        }

        if (!xml || xml.length === 0) {
            return res.json({ subtitles: [], error: '자막 내용이 비어있습니다.' });
        }

        // 3단계: XML 파싱
        const subtitles = parseSubtitleXml(xml, lang || tracks[0].languageCode);
        console.log(`파싱 결과: ${subtitles.length}개`);

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

/*
 * POST /api/summarize
 * body: { text: "자막 전문", title: "영상 제목" }
 *
 * 왜 POST인가:
 *   자막 텍스트가 수만 자일 수 있어 GET 쿼리스트링에 담기 어렵다.
 *
 * 왜 서버에서 호출하는가:
 *   API 키를 클라이언트에 노출하면 누구나 도용할 수 있다.
 *   서버에서 환경변수로 읽어 안전하게 호출한다.
 *
 * 왜 스트리밍인가:
 *   긴 자막의 요약은 수 초 걸릴 수 있어서,
 *   Server-Sent Events로 생성되는 텍스트를 실시간 전송하면
 *   사용자가 기다리지 않고 바로 읽기 시작할 수 있다.
 */
app.post('/api/summarize', async (req, res) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        return res.status(500).json({
            error: 'ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.\n' +
                   '실행: ANTHROPIC_API_KEY=sk-ant-... npm start',
        });
    }

    const { text, title } = req.body;
    if (!text) return res.status(400).json({ error: '자막 텍스트가 없습니다.' });

    // 토큰 절약을 위해 자막 앞부분만 사용 (약 12000자 ≈ 4000토큰)
    const truncated = text.length > 12000
        ? text.substring(0, 12000) + '\n\n... (이하 생략)'
        : text;

    try {
        const client = new Anthropic({ apiKey });

        // SSE 헤더 설정 — 스트리밍 응답용
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
        });

        const stream = await client.messages.stream({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1024,
            messages: [{
                role: 'user',
                content: '다음은 유튜브 영상 [' + (title || '제목 없음') + ']의 자막입니다.\n\n' +
                    '이 영상의 핵심 내용을 한국어로 요약해주세요.\n' +
                    '- 영상의 주제와 핵심 메시지를 먼저 한 줄로 요약\n' +
                    '- 주요 내용을 3~5개 bullet point로 정리\n' +
                    '- 마지막에 한 줄 총평\n\n' +
                    '자막:\n' + truncated,
            }],
        });

        for await (const event of stream) {
            if (event.type === 'content_block_delta' && event.delta?.text) {
                // SSE 형식: data: 텍스트\n\n
                res.write(`data: ${JSON.stringify(event.delta.text)}\n\n`);
            }
        }

        res.write('data: [DONE]\n\n');
        res.end();
    } catch (err) {
        console.error('요약 실패:', err.message);
        // 아직 헤더를 보내지 않았으면 JSON 에러, 이미 보냈으면 SSE 에러
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        } else {
            res.write(`data: ${JSON.stringify('[오류] ' + err.message)}\n\n`);
            res.end();
        }
    }
});

app.listen(PORT, () => {
    console.log(`유튜브 자막 추출기 실행 중: http://localhost:${PORT}`);
    if (!process.env.ANTHROPIC_API_KEY) {
        console.log('⚠ ANTHROPIC_API_KEY가 설정되지 않았습니다. AI 요약 기능을 사용하려면:');
        console.log('  ANTHROPIC_API_KEY=sk-ant-... npm start');
    }
});
