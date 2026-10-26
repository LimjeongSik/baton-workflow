#!/usr/bin/env node
// shared/의 공통 코드를 그 코드를 쓰는 플러그인의 lib/로 복사한다.
// 플러그인은 따로 설치되어 서로의 파일을 import할 수 없으므로 복사본을 둔다. 정본은 shared/에만 고친다.
//
// 사용법:
//   node scripts/sync-shared.mjs          # 복사
//   node scripts/sync-shared.mjs --check  # 어긋난 복사본이 있으면 실패 (테스트·CI용)

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
export const TARGETS = {
    "gate-core.mjs": ["plugins/review/lib", "plugins/security/lib", "plugins/git/lib", "plugins/progress/lib"],
};

const check = process.argv.includes("--check");
const stale = [];
for (const [file, dirs] of Object.entries(TARGETS)) {
    const source = readFileSync(path.join(ROOT, "shared", file), "utf8");
    for (const dir of dirs) {
        const target = path.join(ROOT, dir, file);
        const current = existsSync(target) ? readFileSync(target, "utf8") : null;
        if (current === source) continue;
        if (check) stale.push(path.relative(ROOT, target));
        else writeFileSync(target, source);
    }
}
if (stale.length) {
    console.error(`shared/와 어긋난 복사본: ${stale.join(", ")}. node scripts/sync-shared.mjs로 맞추세요.`);
    process.exit(1);
}
