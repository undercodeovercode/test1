import express from 'express';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { YoutubeTranscript } = require('youtube-transcript');
const app = express();
const PORT = 3000;

app.use(express.static('.'));

/*
 * GET /api/captions/:videoId
 *
 * youtube-transcript 패키지로 자막을 가져온다.
 * 이 패키지는 YouTube의 get_transcript InnerTube 엔드포인트를 사용하여
 * timedtext URL 없이 자막 텍스트를 직접 반환한다.
 * (timedtext baseUrl은 ip=0.0.0.0 서명 문제로 서버에서 사용 불가)
 *
 * lang 파라미터로 특정 언어를 요청할 수 있다.
 */
app.get('/api/captions/:videoId', async (req, res) => {
    const { videoId } = req.params;
    const lang = req.query.lang || undefined;

    try {
        console.log(`\n===== 자막 요청: ${videoId} lang=${lang || '기본'} =====`);

        const config = {};
        if (lang) config.lang = lang;

        const transcript = await YoutubeTranscript.fetchTranscript(videoId, config);
        console.log(`자막 ${transcript.length}개 항목 수신`);

        const subtitles = transcript.map(item => ({
            start: (item.offset || 0) / 1000,
            dur: (item.duration || 0) / 1000,
            text: item.text || '',
        }));

        // 영상 제목은 oEmbed로 별도 가져옴 (youtube-transcript은 제목 미제공)
        res.json({ subtitles });
    } catch (err) {
        console.error('자막 가져오기 실패:', err.message);
        res.status(500).json({ error: err.message, subtitles: [] });
    }
});

/*
 * GET /api/title/:videoId
 * YouTube oEmbed API로 영상 제목을 가져온다 (CORS 지원).
 */
app.get('/api/title/:videoId', async (req, res) => {
    try {
        const resp = await fetch(
            `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${req.params.videoId}&format=json`,
        );
        if (resp.ok) {
            const data = await resp.json();
            return res.json({ title: data.title || '' });
        }
        res.json({ title: '' });
    } catch (_) {
        res.json({ title: '' });
    }
});

app.listen(PORT, () => {
    console.log(`유튜브 자막 추출기 실행 중: http://localhost:${PORT}`);
});
