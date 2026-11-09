// Playwright로 페이지를 전체 높이로 찍는다. render-mockup.sh가 부른다.
//
// 사용법: node shoot.cjs <playwright 모듈 경로> <URL> <out.png> <너비> <높이>
//
// 웹폰트(document.fonts.ready)와 이미지 로딩이 끝날 때까지 기다린 뒤 찍는다.
// 레퍼런스 사이트는 네트워크가 끝나지 않을 수 있어서 networkidle은 시간 제한 안에서만 기다린다.

const [modulePath, target, out, width, height] = process.argv.slice(2);
const { chromium } = require(modulePath);

(async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({
            viewport: { width: Number(width), height: Number(height) },
            deviceScaleFactor: 1,
        });
        await page.goto(target, { waitUntil: "load", timeout: 45000 });
        await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
        await page.evaluate(async () => {
            await document.fonts.ready;
            await Promise.all(
                [...document.images]
                    .filter((img) => !img.complete)
                    .map((img) => new Promise((done) => {
                        img.addEventListener("load", done, { once: true });
                        img.addEventListener("error", done, { once: true });
                    })),
            );
        });
        await page.waitForTimeout(300);
        await page.screenshot({ path: out, fullPage: true });
    } finally {
        await browser.close();
    }
})().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
});
