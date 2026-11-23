#!/usr/bin/env node
// learn/ 학습 파일의 프로젝트별 잠금. 여러 세션의 recorder가 같은 learn/을 동시에 고치지 않게 한다.
// recorder는 기록 → 정리 → scrub 전체를 잠금 안에서 한다.
//
//   node lock.mjs acquire <프로젝트 루트>          # 잠금을 잡고 토큰을 출력한다. 다른 세션이 잡고 있으면 기다린다
//   node lock.mjs release <프로젝트 루트> <토큰>   # 자기 토큰일 때만 푼다
//
// 잠금은 learn/.lock 폴더다(mkdir은 원자적이라 둘이 동시에 잡을 수 없다). 잡은 세션이 비정상 종료해 남은 잠금은
// STALE_MS가 지나면 새로 잡는다. 기다려도 못 잡으면 종료 코드 1로 끝나고, 그때는 이번 기록을 건너뛴다.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const STALE_MS = Number(process.env.PREFS_LOCK_STALE_MS ?? 10 * 60 * 1000);
const WAIT_MS = Number(process.env.PREFS_LOCK_WAIT_MS ?? 60 * 1000);
const POLL_MS = 200;

const [command, rootArg, token] = process.argv.slice(2);
if (!["acquire", "release"].includes(command) || !rootArg) {
    console.error("사용법: node lock.mjs acquire <프로젝트 루트> | release <프로젝트 루트> <토큰>");
    process.exit(2);
}
const learnDir = path.join(path.resolve(rootArg), "learn");
const lockDir = path.join(learnDir, ".lock");
const ownerFile = path.join(lockDir, "owner.json");
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const readOwner = () => {
    try {
        return JSON.parse(readFileSync(ownerFile, "utf8"));
    } catch {
        return null;
    }
};

if (command === "acquire") {
    mkdirSync(learnDir, { recursive: true });
    const mine = randomBytes(8).toString("hex");
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
        try {
            mkdirSync(lockDir);
            writeFileSync(ownerFile, `${JSON.stringify({ token: mine, pid: process.ppid, at: new Date().toISOString() })}\n`);
            console.log(mine);
            process.exit(0);
        } catch (error) {
            if (error.code !== "EEXIST") throw error;
        }
        let age = 0;
        try {
            age = Date.now() - statSync(lockDir).mtimeMs;
        } catch {
            continue; // 그 사이 풀렸다
        }
        if (age > STALE_MS) {
            rmSync(lockDir, { recursive: true, force: true });
            console.error(`남아 있던 잠금(${Math.round(age / 60000)}분 전)을 정리했습니다.`);
            continue;
        }
        if (Date.now() > deadline) {
            const owner = readOwner();
            console.error(`다른 세션이 learn/을 기록 중입니다${owner?.at ? ` (${owner.at}부터)` : ""}. 이번 기록은 건너뛴다.`);
            process.exit(1);
        }
        sleep(POLL_MS);
    }
} else {
    if (!existsSync(lockDir)) {
        console.log("잠금이 없습니다.");
        process.exit(0);
    }
    const owner = readOwner();
    if (owner && owner.token !== token) {
        console.error("다른 세션의 잠금이라 풀지 않았습니다.");
        process.exit(1);
    }
    rmSync(lockDir, { recursive: true, force: true });
    console.log("잠금을 풀었습니다.");
}
