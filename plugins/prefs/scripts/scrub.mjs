#!/usr/bin/env node
// learn/ 폴더의 학습 파일에서 시크릿·개인 정보로 보이는 값을 가린다. recorder가 기록을 마칠 때마다 실행한다.
//
//   node scrub.mjs <프로젝트 루트>
//
// 가린 개수만 출력하고 값은 출력하지 않는다.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { redact } from "./secrets.mjs";

const root = path.resolve(process.argv[2] ?? process.cwd());
let total = 0;
for (const name of ["observed.md", "learned.md"]) {
    const file = path.join(root, "learn", name);
    if (!existsSync(file)) continue;
    const { text, count } = redact(readFileSync(file, "utf8"));
    if (count > 0) writeFileSync(file, text);
    total += count;
    if (count > 0) console.log(`learn/${name}: ${count}개 값을 가렸습니다.`);
}
if (total === 0) console.log("가릴 값이 없습니다.");
