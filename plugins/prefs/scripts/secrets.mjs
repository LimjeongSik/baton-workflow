// learn/ 파일에 들어가면 안 되는 값을 가린다: 키·토큰·비밀번호처럼 보이는 값, 자격 증명이 든 URL, 사설 IP,
// 사용자 이름이 드러나는 홈 경로, 이메일, 전화번호, 주민번호, 카드 번호.
// session-load 훅은 세션을 시작할 때 파일에서 지우고 가린 내용만 컨텍스트에 넣는다. recorder도 기록을 마칠 때 scrub.mjs로 지운다.
// 학습은 "어떻게 일하는가"만 남기므로 값 자체는 필요 없다. 그래서 의심스러우면 가린다.

const RULES = [
    [/AKIA[0-9A-Z]{16}/g, "[가린 값: AWS 키]"],
    [/sk_(live|test)_[0-9A-Za-z]{8,}/g, "[가린 값: 결제 키]"],
    [/sk-(proj-)?[A-Za-z0-9_-]{20,}/g, "[가린 값: API 키]"],
    [/gh[pousr]_[A-Za-z0-9]{36}/g, "[가린 값: GitHub 토큰]"],
    [/xox[baprs]-[A-Za-z0-9-]{10,}/g, "[가린 값: Slack 토큰]"],
    [/AIza[0-9A-Za-z_-]{35}/g, "[가린 값: Google 키]"],
    [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[가린 값: JWT]"],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[가린 값: 개인 키]"],
    [/((?:api[_-]?key|secret|password|passwd|token|client[_-]?secret|access[_-]?key)["']?\s*[:=]\s*["']?)(?=[^\s"'`,;]*\d)[^\s"'`,;]{6,}/gi, "$1[가린 값]"],
    [/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/g, "$1[가린 값]"],
    [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/gi, "$1[가린 자격 증명]@"],
    [/\b(10\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g, "[가린 값: 사설 IP]"],
    [/(\/Users\/|\/home\/|[A-Z]:\\Users\\)[^\s/\\]+/g, "~"],
    [/\b(?:\d{4}[- ]?){3}\d{4}\b/g, "[가린 값: 카드 번호]"],
    [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[가린 값: 이메일]"],
    [/\b01[016789]-?\d{3,4}-?\d{4}\b/g, "[가린 값: 전화번호]"],
    [/\b\d{6}-?[1-4]\d{6}\b/g, "[가린 값: 주민번호]"],
];

export function redact(text) {
    let count = 0;
    let result = text;
    for (const [pattern, replacement] of RULES) {
        result = result.replace(pattern, (...match) => {
            count += 1;
            return replacement.replace("$1", match[1] ?? "");
        });
    }
    return { text: result, count };
}
