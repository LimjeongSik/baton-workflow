#!/usr/bin/env node
// baton 마켓플레이스 목록을 갱신하고, 설치된 baton 플러그인을 범위(user·project·local)와 프로젝트별로 모두 업데이트한다.
//
// /baton:update 스킬이 실행한다. 터미널에서는 node ~/.claude/plugins/marketplaces/baton/plugins/baton/scripts/update.mjs [--dry-run]
// project·local 범위 설치는 그 프로젝트 폴더에서 -s를 붙여 업데이트한다. 폴더가 사라진 설치는 건너뛴다.
// 적용하려면 열려 있는 Claude Code 세션에서 /reload-plugins를 실행하거나 재시작한다.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

const MARKETPLACE = "baton";
const dryRun = process.argv.includes("--dry-run");

const claude = (args, cwd = homedir()) => {
    console.log(`$ ${cwd === homedir() ? "" : `(${cwd}) `}claude ${args.join(" ")}`);
    if (dryRun) return true;
    return spawnSync("claude", args, { cwd, stdio: "inherit" }).status === 0;
};

if (!claude(["plugin", "marketplace", "update", MARKETPLACE])) {
    console.error("마켓플레이스 갱신에 실패했다. 위 출력을 확인한다.");
    process.exit(1);
}

const installs = JSON.parse(execFileSync("claude", ["plugin", "list", "--json"], { encoding: "utf8" })).filter((p) =>
    p.id.endsWith(`@${MARKETPLACE}`),
);

const seen = new Set();
const failed = [];
const skipped = [];
for (const p of installs) {
    const cwd = p.scope === "project" || p.scope === "local" ? p.projectPath : homedir();
    const key = `${p.id}|${p.scope}|${cwd}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!cwd || !existsSync(cwd)) {
        skipped.push(`${p.id} (${p.scope}, ${p.projectPath ?? "경로 없음"})`);
        continue;
    }
    if (!claude(["plugin", "update", p.id, "-s", p.scope], cwd)) failed.push(`${p.id} (${p.scope}, ${cwd})`);
}

console.log(`\n업데이트 ${seen.size - skipped.length - failed.length}개, 실패 ${failed.length}개, 건너뜀 ${skipped.length}개`);
for (const f of failed) console.log(`  실패: ${f}`);
for (const s of skipped) console.log(`  건너뜀 (폴더 없음): ${s}`);
if (!dryRun) console.log("열려 있는 Claude Code 세션에서 /reload-plugins를 실행하거나 재시작하면 적용된다.");
process.exit(failed.length ? 1 : 0);
