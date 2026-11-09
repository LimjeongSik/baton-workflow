// Playwright로 페이지를 전체 높이로 찍는다. render-mockup.sh가 부른다.
//
// 사용법: node shoot.cjs <playwright 모듈 경로> <URL> <out.png> <너비> <높이>
//
// 웹폰트(document.fonts.ready)와 이미지 로딩을 READY_LIMIT_MS까지만 기다린 뒤 찍는다.
// 그때까지 끝나지 않은 것과 로딩에 실패한 이미지는 "WARN:" 줄로 남긴다.
// 레퍼런스 사이트는 네트워크가 끝나지 않을 수 있어서 networkidle도 시간 제한 안에서만 기다린다.

const READY_LIMIT_MS = 8000;

const [modulePath, target, out, width, height] = process.argv.slice(2);
const { chromium } = require(modulePath);

(async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({
            viewport: { width: Number(width), height: Number(height) },
            deviceScaleFactor: 1,
        });
        // load 이벤트는 느린 이미지 하나에도 끝없이 늦어질 수 있어서, 문서만 받으면 진행하고 나머지는 시간 제한 안에서 기다린다.
        await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45000 });
        await page.waitForLoadState("load", { timeout: READY_LIMIT_MS }).catch(() => {});
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
        const warnings = await page.evaluate(async (limit) => {
            // 화면 밖의 지연 로딩 이미지는 스크롤 전까지 받지 않아서 전체 페이지 캡처에 빈칸으로 찍힌다.
            for (const img of document.images) {
                if (img.loading === "lazy") img.loading = "eager";
            }
            const settled = (img) => new Promise((done) => {
                if (img.complete) return done();
                img.addEventListener("load", done, { once: true });
                img.addEventListener("error", done, { once: true });
            });
            let timedOut = false;
            await Promise.race([
                Promise.all([document.fonts.ready, ...[...document.images].map(settled)]),
                new Promise((done) => setTimeout(() => { timedOut = true; done(); }, limit)),
            ]);

            const short = (src) => (src.length > 100 ? `${src.slice(0, 97)}...` : src);
            const result = [];
            if (timedOut && document.fonts.status !== "loaded") {
                result.push(`${limit / 1000}초 안에 웹폰트 로딩이 끝나지 않았다. 대체 서체로 찍혔을 수 있다`);
            }
            for (const img of document.images) {
                if (!img.currentSrc && !img.src) continue;
                if (!img.complete) result.push(`${limit / 1000}초 안에 로딩이 끝나지 않은 이미지: ${short(img.currentSrc || img.src)}`);
                else if (img.naturalWidth === 0) result.push(`로딩에 실패해 표시되지 않은 이미지: ${short(img.currentSrc || img.src)}`);
            }
            return result;
        }, READY_LIMIT_MS);
        await page.waitForTimeout(300);
        await page.screenshot({ path: out, fullPage: true });
        for (const w of warnings) console.log(`WARN: ${w}`);
    } finally {
        await browser.close();
    }
})().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
});
