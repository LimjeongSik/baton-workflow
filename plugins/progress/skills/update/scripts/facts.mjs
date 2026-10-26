#!/usr/bin/env node
// 진행 문서를 쓰기 전에 확인할 사실을 모은다. 문서에는 여기 나온 사실과 실제로 실행한 결과만 적는다.
//
//   node facts.mjs [진행 문서 경로]   # 기본 DOCS_PROGRESS_PATH 또는 docs/PROGRESS.md
//
// - 문서의 최종 갱신일과 그 뒤의 커밋 (진행 문서만 바꾼 커밋 제외)
// - 커밋되지 않은 변경 (아직 "완료"로 쓸 수 없는 것)
// - git:ship이 남긴 검사·테스트 기록과, 그 기록이 지금 작업 트리 내용과 같은지 (같으면 7절에 그대로 쓸 수 있다)
// - 리뷰·보안 감사를 마지막으로 통과한 시각

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { git, lines, repoRoot, snapshotTree, tryGit } from "../../../lib/gate-core.mjs";

const root = repoRoot(process.cwd());
if (!root) {
    console.error("git 저장소가 아닙니다.");
    process.exit(2);
}
const doc = process.argv[2] ?? process.env.DOCS_PROGRESS_PATH ?? "docs/PROGRESS.md";
const docFile = path.join(root, doc);
const readJson = (file) => {
    try {
        return JSON.parse(readFileSync(file, "utf8"));
    } catch {
        return null;
    }
};
const gitPath = (name) => path.resolve(root, git(root, "rev-parse", "--git-path", name));

const out = [];
const updated = existsSync(docFile) ? readFileSync(docFile, "utf8").match(/최종 갱신:\s*(\d{4}-\d{2}-\d{2})/)?.[1] : null;
out.push(`## 진행 문서\n${existsSync(docFile) ? `${doc} · 최종 갱신 ${updated ?? "(형식 없음)"}` : `${doc} 없음 → init으로 만든다`}`);

const since = updated ? ["--since", `${updated} 00:00`] : ["-30"];
const commits = lines(tryGit(root, "log", "--format=%h %ad %s", "--date=short", ...since, "--", ".", `:(exclude)${doc}`) ?? "");
out.push(`## 갱신일 이후 커밋 (${commits.length}개)\n${commits.slice(0, 30).join("\n") || "없음"}`);

const status = lines(git(root, "status", "--porcelain", "--untracked-files=all")).filter((line) => !line.endsWith(doc));
out.push(
    `## 커밋되지 않은 변경 (${status.length}개)\n${status.slice(0, 20).join("\n") || "없음"}${status.length ? "\n→ 커밋되지 않은 작업은 3절에 완료로 쓰지 않고, 2절에 진행 중으로 쓴다." : ""}`,
);

const pipeline = readJson(path.join(gitPath("baton"), "pipeline.json"));
const verify = ["## 마지막 검증 기록 (git:ship)"];
if (!pipeline?.stages || Object.keys(pipeline.stages).length === 0) {
    verify.push("기록 없음 → 7절은 검사 명령을 직접 실행해서 쓴다.");
} else {
    const fresh = pipeline.fingerprint === snapshotTree(root);
    for (const [stage, entry] of Object.entries(pipeline.stages)) {
        verify.push(`${stage}: ${entry.status === "passed" ? "통과" : `실패 (${entry.reason})`} · ${entry.at}${entry.cmd ? ` · ${entry.cmd}` : ""}`);
    }
    verify.push(fresh ? "→ 지금 작업 트리와 같은 내용의 기록이다. 7절에 그대로 쓸 수 있다." : "→ 기록 뒤에 파일이 바뀌었다. 7절은 검사를 다시 실행해서 쓴다.");
}
out.push(verify.join("\n"));

const lastPass = (dir, file) => readJson(path.join(gitPath(dir), file))?.history?.at(-1);
const review = lastPass("codex-review", "reviewed.json");
const audit = lastPass("security-audit", "passed.json");
const describePass = (entry) => (entry ? `${entry.at}${entry.skipped ? ` (생략: ${entry.skipped})` : entry.auto ? ` (자동: ${entry.auto})` : ""}` : "기록 없음");
out.push(`## 리뷰·감사\n리뷰 마지막 통과: ${describePass(review)}\n보안 감사 마지막 통과: ${describePass(audit)}`);

console.log(out.join("\n\n"));
