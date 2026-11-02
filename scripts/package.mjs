#!/usr/bin/env node
// 배포용 ZIP을 만든다. git archive로 커밋된 파일만 담으므로 .git/, .DS_Store, __MACOSX/ 같은 로컬 파일은 들어가지 않는다.
// 개발용 파일(테스트, 공통 코드 정본, 이 스크립트들)은 .gitattributes의 export-ignore로 뺀다.
//
// 사용법:
//   node scripts/package.mjs          # HEAD를 dist/baton-<커밋>.zip으로
//   node scripts/package.mjs <ref>    # 특정 태그·커밋을

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();

const ref = process.argv[2] ?? "HEAD";
if (ref === "HEAD" && git("status", "--porcelain")) {
    console.error("커밋되지 않은 변경은 ZIP에 들어가지 않습니다. 커밋한 뒤 다시 실행하세요.");
    process.exit(1);
}
const name = `baton-${git("describe", "--tags", "--always", ref)}`;
const out = path.join(ROOT, "dist", `${name}.zip`);
mkdirSync(path.dirname(out), { recursive: true });
git("archive", "--format=zip", `--prefix=${name}/`, "-o", out, ref);
const entries = execFileSync("unzip", ["-Z1", out], { encoding: "utf8" }).trim().split("\n").length;
console.log(`${path.relative(ROOT, out)} (${entries}개 항목)`);
