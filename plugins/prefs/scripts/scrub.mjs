#!/usr/bin/env node
// learn/ 폴더의 학습 파일에서 시크릿·개인 정보로 보이는 값을 가린다. recorder가 기록을 마칠 때마다 실행한다.
//
//   node scrub.mjs <프로젝트 루트>
//
// 가린 개수만 출력하고 값은 출력하지 않는다.
// recorder는 lock.mjs로 잡은 잠금 안에서 실행한다. 잠금 밖에서 돌더라도 다른 세션이 붙인 줄을 덮어쓰지 않도록,
// 쓰기 직전에 파일을 다시 읽어 그 사이 바뀌었으면 처음부터 다시 하고, 임시 파일에 쓴 뒤 rename으로 바꾼다.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { redact } from "./secrets.mjs";

const root = path.resolve(process.argv[2] ?? process.cwd());
let total = 0;
for (const name of ["observed.md", "learned.md"]) {
    const file = path.join(root, "learn", name);
    if (!existsSync(file)) continue;
    let count = 0;
    for (let attempt = 0; attempt < 5; attempt++) {
        const original = readFileSync(file, "utf8");
        const result = redact(original);
        count = result.count;
        if (count === 0) break;
        if (readFileSync(file, "utf8") !== original) continue; // 그 사이 다른 세션이 고쳤다: 새 내용으로 다시
        const temp = `${file}.scrub-${process.pid}`;
        writeFileSync(temp, result.text);
        renameSync(temp, file);
        break;
    }
    total += count;
    if (count > 0) console.log(`learn/${name}: ${count}개 값을 가렸습니다.`);
}
if (total === 0) console.log("가릴 값이 없습니다.");
