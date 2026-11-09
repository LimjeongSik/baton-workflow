// ui 플러그인의 palette-check.mjs 테스트.
// 역할별 대비 조합 검사, 스타일 경고와 대비 실패의 구분, 최소 수정안, 종료 코드(0 통과·1 대비 실패·2 입력 오류)를 확인한다.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

const CHECK = path.resolve(import.meta.dirname, "../plugins/ui/skills/design/scripts/palette-check.mjs");

const run = (...args) => {
    const r = spawnSync(process.execPath, [CHECK, ...args], { encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr };
};

describe("palette-check", () => {
    test("인자가 없으면 사용법을 알리고 2로 끝난다", () => {
        assert.equal(run().code, 2);
    });

    test("스타일 경고만 있으면 0으로 끝난다", () => {
        const { code, out } = run("--bg", "#F2F4F0", "--fg", "#1F2421", "#6366F1");
        assert.equal(code, 0);
        assert.match(out, /스타일 경고 \d+건/);
        assert.match(out, /대비 실패 없음/);
    });

    test("역할별 조합의 대비 실패를 이름과 함께 알리고 1로 끝난다", () => {
        const { code, out } = run(
            "--text", "#FFFFFF/#2F6B4F=주요 버튼",
            "--text", "#9AA39D/#FFFFFF=카드 보조 텍스트",
            "--large", "#767676/#FFFFFF=큰 제목",
            "--ui", "#DDE3DA/#FFFFFF=입력창 테두리",
        );
        assert.equal(code, 1);
        assert.match(out, /✓ 주요 버튼/);
        assert.match(out, /✖ 카드 보조 텍스트/);
        assert.match(out, /✓ 큰 제목/);
        assert.match(out, /✖ 입력창 테두리/);
        assert.match(out, /대비 실패 2건: 카드 보조 텍스트, 입력창 테두리/);
    });

    test("--bg와 --fg는 본문 조합으로 검사한다", () => {
        const { code, out } = run("--bg", "#FFFFFF", "--fg", "#AAAAAA");
        assert.equal(code, 1);
        assert.match(out, /✖ 본문/);
    });

    test("입력 오류는 검사하지 않고 2로 끝난다", () => {
        for (const args of [
            ["--bg", "invalid", "--fg", "#111111"],
            ["--bg"],
            ["--bg", "#FFFFFF", "--fg"],
            ["--bg", "--fg", "#111111"],
            ["--foo", "#FFFFFF"],
            ["#zzz"],
            ["--text", "white on green"],
        ]) {
            const { code, out } = run(...args);
            assert.equal(code, 2, args.join(" "));
            assert.equal(out, "", args.join(" "));
        }
    });

    test("대비 실패에 명도만 조정한 최소 수정안을 붙인다", () => {
        const { out } = run("--text", "#9AA39D/#FFFFFF=보조");
        const fix = /최소 수정안: 앞쪽 색 #9AA39D → (#[0-9A-F]{6})/.exec(out);
        assert.ok(fix, out);
        assert.equal(run("--text", `${fix[1]}/#FFFFFF=보조`).code, 0);
    });

    test("순백 배경은 Tailwind 경고를 내지 않는다", () => {
        const { out } = run("--bg", "#FFFFFF", "--fg", "#1F2421");
        assert.doesNotMatch(out, /Tailwind/);
    });
});
