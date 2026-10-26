// baton 게이트 공통 코드: 변경 수집, 통과 기록, git 명령 해석, 위험도 판정, 리뷰 델타, git 훅 백스톱.
//
// 정본은 저장소 루트의 shared/gate-core.mjs다. 플러그인은 따로 설치되므로 review·security·git 플러그인의 lib/에
// 같은 파일을 복사해 둔다. 고칠 때는 정본을 고치고 `node scripts/sync-shared.mjs`로 복사한다 (테스트가 어긋남을 잡는다).
//
// 통과 기록은 파일 내용(blob 해시) 단위다. 기록 뒤에 파일이 바뀌면 다시 검사 대상이 되지만,
// 공백·줄바꿈만 바뀐 경우(공백이 의미를 갖는 언어 제외)는 이전 통과를 이어받는다.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const DELETED = "-";
const STATE_VERSION = 2;
const MAX_HASHES_PER_FILE = 20;
const MAX_COMPARE_BYTES = 1024 * 1024;

// ─── git ────────────────────────────────────────────────────────────────────

export function git(cwd, ...args) {
    return gitWith(cwd, args);
}

function gitWith(cwd, args, { env, input } = {}) {
    return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        env: env ? { ...process.env, ...env } : process.env,
        input,
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
        maxBuffer: 64 * 1024 * 1024,
    }).trimEnd();
}

export function tryGit(cwd, ...args) {
    try {
        return git(cwd, ...args);
    } catch {
        return null;
    }
}

export function lines(output) {
    return output ? output.split("\n").filter(Boolean) : [];
}

export function repoRoot(cwd) {
    return tryGit(cwd, "rev-parse", "--show-toplevel");
}

export function hasHead(root) {
    return tryGit(root, "rev-parse", "-q", "--verify", "HEAD") !== null;
}

// ─── 소스 판정 ──────────────────────────────────────────────────────────────

// 검사 대상이 아닌 파일: 문서, 에셋, lockfile, 도구 설정
const NON_SOURCE_EXTENSIONS = new Set([
    ".md", ".mdx", ".markdown", ".txt", ".rst", ".adoc",
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".svg", ".bmp", ".heic",
    ".ttf", ".otf", ".woff", ".woff2", ".eot",
    ".mp3", ".mp4", ".mov", ".wav", ".webm", ".pdf", ".zip",
]);
const NON_SOURCE_FILES = new Set([
    "LICENSE", "LICENCE", "NOTICE", "CHANGELOG", "AUTHORS", "CODEOWNERS", ".gitignore", ".gitattributes",
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb", "Cargo.lock", "poetry.lock",
    "uv.lock", "Gemfile.lock", "composer.lock", "go.sum", "Podfile.lock",
]);
const NON_SOURCE_PREFIXES = [".claude/", ".design/", ".github/ISSUE_TEMPLATE/"];

// 공백·들여쓰기가 의미를 갖는 파일: 공백만 바뀌어도 통과를 이어받지 않는다
const WHITESPACE_SENSITIVE = /(\.(py|pyi|yaml|yml|mk|haml|pug|jade|sass|styl|coffee|nim|slim|tsv)|(^|\/)(Makefile|GNUmakefile|Dockerfile))$/i;

export function isSource(relPath) {
    if (NON_SOURCE_PREFIXES.some((prefix) => relPath.startsWith(prefix))) return false;
    const base = path.basename(relPath);
    if (NON_SOURCE_FILES.has(base)) return false;
    return !NON_SOURCE_EXTENSIONS.has(path.extname(base).toLowerCase());
}

// ─── 변경 수집 ──────────────────────────────────────────────────────────────

function worktreeHash(root, relPath, { write = false } = {}) {
    if (!existsSync(path.join(root, relPath))) return DELETED;
    return write ? git(root, "hash-object", "-w", "--", relPath) : git(root, "hash-object", "--", relPath);
}

// name-status 한 줄을 { path, deleted }로. rename(R)·copy(C)는 새 경로와 함께 옛 경로의 삭제로 본다.
function parseNameStatus(output) {
    const entries = [];
    for (const line of lines(output)) {
        const [status, ...paths] = line.split("\t");
        if (status.startsWith("R")) {
            entries.push({ path: paths[0], deleted: true }, { path: paths[1], deleted: false });
        } else if (status.startsWith("C")) {
            entries.push({ path: paths[1], deleted: false });
        } else {
            entries.push({ path: paths[0], deleted: status === "D" });
        }
    }
    return entries;
}

// 아직 커밋되지 않은 소스 변경: 커밋에 담길 수 있는 모든 내용 (index와 작업 트리 양쪽)
// write를 주면 작업 트리 내용을 object로 저장해, 나중에 공백 비교와 리뷰 델타에 쓸 수 있게 한다.
export function pendingChanges(root, { write = false } = {}) {
    const base = hasHead(root) ? "HEAD" : EMPTY_TREE;
    const changes = [];

    // index에 올라간 내용
    for (const entry of parseNameStatus(git(root, "diff", "--cached", "--name-status", "-M", base))) {
        if (!isSource(entry.path)) continue;
        const hash = entry.deleted ? DELETED : git(root, "rev-parse", `:${entry.path}`);
        changes.push({ path: entry.path, hash, where: "staged" });
    }
    // 작업 트리 내용 (tracked 수정·삭제, untracked)
    const untracked = new Set(lines(git(root, "ls-files", "--others", "--exclude-standard")));
    const worktreePaths = new Set([
        ...parseNameStatus(git(root, "diff", "--name-status", "-M", base)).map((entry) => entry.path),
        ...untracked,
    ]);
    for (const relPath of worktreePaths) {
        if (!isSource(relPath)) continue;
        changes.push({ path: relPath, hash: worktreeHash(root, relPath, { write }), where: "worktree", untracked: untracked.has(relPath) });
    }
    return dedupe(changes);
}

// 원격에 없는 커밋들의 시작점. 없으면 null.
export function unpushedBase(root, { upstream } = {}) {
    if (!hasHead(root)) return null;
    const tracking = upstream ?? tryGit(root, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}");
    if (tracking) {
        const base = tryGit(root, "merge-base", tracking, "HEAD");
        return base && base !== git(root, "rev-parse", "HEAD") ? base : null;
    }
    const commits = lines(git(root, "rev-list", "--reverse", "HEAD", "--not", "--remotes"));
    if (commits.length === 0) return null;
    return tryGit(root, "rev-parse", "-q", "--verify", `${commits[0]}^`) ?? EMPTY_TREE;
}

// base..tip 사이에 바뀐 소스 파일의 tip 시점 내용
export function rangeChanges(root, base, tip = "HEAD") {
    const changes = [];
    for (const entry of parseNameStatus(git(root, "diff", "--name-status", "-M", base, tip))) {
        if (!isSource(entry.path)) continue;
        const hash = entry.deleted ? DELETED : git(root, "rev-parse", `${tip}:${entry.path}`);
        changes.push({ path: entry.path, hash, where: "unpushed" });
    }
    return dedupe(changes);
}

// 아직 원격에 없는 커밋들이 바꾼 소스 파일의 HEAD 시점 내용
export function unpushedChanges(root, options = {}) {
    const base = unpushedBase(root, options);
    return base ? rangeChanges(root, base, "HEAD") : [];
}

function dedupe(changes) {
    const seen = new Set();
    return changes.filter((change) => {
        const key = `${change.path}\0${change.hash}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export function describe(changes, limit = 8) {
    const names = [...new Set(changes.map((change) => change.path))];
    return names.slice(0, limit).join(", ") + (names.length > limit ? ` 외 ${names.length - limit}개` : "");
}

// ─── 공백만 바뀐 변경 ───────────────────────────────────────────────────────

// 공백 덩어리를 하나로 줄이고, 단어 사이가 아닌 공백은 지운다. `return x`와 `returnx`는 다르게 남는다.
function normalizeWhitespace(text) {
    return text.replace(/\s+/g, " ").replace(/ (?=\W)|(?<=\W) /g, "").trim();
}

function readBlob(root, hash) {
    if (!hash || hash === DELETED) return null;
    try {
        const size = Number(git(root, "cat-file", "-s", hash));
        if (size > MAX_COMPARE_BYTES) return null;
        return gitWith(root, ["cat-file", "blob", hash]);
    } catch {
        return null;
    }
}

function currentContent(root, change) {
    if (change.hash === DELETED) return null;
    if (change.where === "worktree") {
        try {
            const file = path.join(root, change.path);
            if (statSync(file).size > MAX_COMPARE_BYTES) return null;
            return readFileSync(file, "utf8").trimEnd();
        } catch {
            return null;
        }
    }
    return readBlob(root, change.hash);
}

// 통과한 내용 중 하나와 공백만 다르면 그 해시를 돌려준다
function whitespaceOnlyMatch(root, change, passedHashes) {
    if (WHITESPACE_SENSITIVE.test(change.path) || passedHashes.length === 0) return null;
    const current = currentContent(root, change);
    if (current === null) return null;
    const normalized = normalizeWhitespace(current);
    for (const hash of [...passedHashes].reverse()) {
        const previous = readBlob(root, hash);
        if (previous !== null && normalizeWhitespace(previous) === normalized) return hash;
    }
    return null;
}

// ─── 통과 기록 저장소 ───────────────────────────────────────────────────────

// dir: <git-dir> 아래 폴더 이름, file: 기록 파일 이름, ref: 기준점 ref (없어도 된다)
export function createStore({ dir: dirName, file: fileName, ref = null }) {
    const stateFile = (root) => {
        const dir = path.resolve(root, git(root, "rev-parse", "--git-path", dirName));
        return { dir, file: path.join(dir, fileName) };
    };

    // 버전 호환: 버전이 없으면 1(0.2.x 이하)로 보고 그대로 읽는다. files·history의 형태는 버전 사이에 바뀌지 않는다.
    // 모르는 필드는 저장할 때 그대로 둔다. 더 새 버전이 쓴 기록은 읽기만 하고 덮어쓰지 않는다 (플러그인을 되돌렸을 때 기록을 잃지 않게).
    const load = (root) => {
        let state = {};
        try {
            state = JSON.parse(readFileSync(stateFile(root).file, "utf8"));
        } catch {}
        return { ...state, version: state.version ?? 1, files: state.files ?? {}, history: state.history ?? [] };
    };

    const save = (root, state) => {
        if (state.version > STATE_VERSION) {
            throw new Error(
                `${stateFile(root).file}은 더 새 버전(${state.version})의 플러그인이 쓴 기록이라 덮어쓰지 않습니다. 플러그인을 업데이트하세요 (/baton:update).`,
            );
        }
        const { dir, file } = stateFile(root);
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, `${JSON.stringify({ ...state, version: STATE_VERSION }, null, 2)}\n`);
    };

    const isPassed = (root, change, files = load(root).files) => {
        const passed = files[change.path] ?? [];
        return passed.includes(change.hash) || whitespaceOnlyMatch(root, change, passed) !== null;
    };

    return {
        ref,
        load,
        isPassed,
        hasHistory(root) {
            return existsSync(stateFile(root).file) || (ref !== null && tryGit(root, "rev-parse", "-q", "--verify", ref) !== null);
        },
        // 통과 기록이 없는 변경만 남긴다. 공백만 바뀐 변경은 이전 통과를 이어받는다.
        unchecked(root, changes) {
            const { files } = load(root);
            return changes.filter((change) => !isPassed(root, change, files));
        },
        // 지금 시점의 미커밋·미푸시 소스 내용을 통과로 기록한다. ref가 있으면 HEAD로 옮긴다.
        mark(root, { reason = null, logFile = null, auto = null } = {}) {
            const state = load(root);
            const changes = [...pendingChanges(root, { write: true }), ...unpushedChanges(root)];
            for (const change of changes) {
                const hashes = state.files[change.path] ?? [];
                if (!hashes.includes(change.hash)) hashes.push(change.hash);
                state.files[change.path] = hashes.slice(-MAX_HASHES_PER_FILE);
            }
            const head = hasHead(root) ? git(root, "rev-parse", "HEAD") : null;
            state.history = [
                ...state.history,
                {
                    at: new Date().toISOString(),
                    head,
                    files: changes.length,
                    ...(reason ? { skipped: reason } : {}),
                    ...(auto ? { auto } : {}),
                    ...(logFile ? { log: logFile } : {}),
                },
            ].slice(-50);
            save(root, state);
            if (ref && head) git(root, "update-ref", ref, head);
            return changes;
        },
    };
}

// ─── git 명령 해석 ──────────────────────────────────────────────────────────

// 셸 명령을 따옴표를 존중해 토큰과 연산자(&&, ||, ;, |, 줄바꿈, 괄호, 백틱)로 나눈다.
function lex(cmd) {
    const out = [];
    let cur = "";
    let has = false;
    const push = () => {
        if (has) out.push({ word: cur });
        cur = "";
        has = false;
    };
    for (let i = 0; i < cmd.length; i++) {
        const c = cmd[i];
        if (c === "'") {
            const j = cmd.indexOf("'", i + 1);
            cur += cmd.slice(i + 1, j < 0 ? cmd.length : j);
            has = true;
            i = j < 0 ? cmd.length : j;
        } else if (c === '"') {
            let j = i + 1;
            while (j < cmd.length && cmd[j] !== '"') {
                if (cmd[j] === "\\" && j + 1 < cmd.length) j++;
                cur += cmd[j];
                j++;
            }
            has = true;
            i = j;
        } else if (c === "\\" && i + 1 < cmd.length) {
            cur += cmd[++i];
            has = true;
        } else if (/\s/.test(c) && c !== "\n") {
            push();
        } else if (c === "\n" || c === ";" || c === "|" || c === "&" || c === "(" || c === ")" || c === "`") {
            push();
            if ((c === "&" || c === "|") && cmd[i + 1] === c) i++;
            out.push({ op: c });
        } else {
            cur += c;
            has = true;
        }
    }
    push();
    return out;
}

function segments(cmd) {
    const result = [[]];
    for (const token of lex(cmd)) {
        if (token.op) result.push([]);
        else result[result.length - 1].push(token.word);
    }
    return result.filter((words) => words.length > 0);
}

const expandHome = (p) => p.replace(/^~(?=$|\/)/, process.env.HOME ?? "~");

export const realpathOr = (p) => {
    try {
        return realpathSync(p);
    } catch {
        return p;
    }
};

// 값을 하나 받는 commit 옵션 (이 값은 경로가 아니다)
const COMMIT_VALUE_OPTIONS = new Set([
    "-m", "--message", "-F", "--file", "-C", "--reuse-message", "-c", "--reedit-message",
    "--author", "--date", "-t", "--template", "--fixup", "--squash", "--cleanup", "--trailer", "-S", "--gpg-sign",
]);
// 뒤에 오는 명령을 그대로 실행하는 접두 명령. 옵션과 숫자 인자(timeout 10 등)는 건너뛴다.
const PREFIX_COMMANDS = new Set(["env", "command", "builtin", "exec", "nohup", "time", "nice", "sudo", "timeout", "stdbuf"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const GIT_SUBCOMMANDS = new Set([
    "add", "stage", "commit", "push", "status", "diff", "log", "show", "fetch", "pull", "merge", "rebase", "reset",
    "checkout", "switch", "restore", "branch", "tag", "stash", "rev-parse", "config", "remote", "init", "clone",
    "worktree", "cherry-pick", "revert", "rm", "mv", "ls-files", "blame", "grep", "describe", "help",
]);

function stripPrefixes(tokens) {
    const rest = [...tokens];
    for (;;) {
        while (rest.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0])) rest.shift(); // VAR=값 접두사
        if (!rest.length || !PREFIX_COMMANDS.has(path.basename(rest[0]))) return rest;
        rest.shift();
        while (rest.length && (rest[0].startsWith("-") || /^\d+[smhd]?$/.test(rest[0]))) rest.shift();
    }
}

function gitAlias(dir, name) {
    try {
        return execFileSync("git", ["config", "--get", `alias.${name}`], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
        return null;
    }
}

// cd를 따라가며 git 호출을 찾고, 커밋에 담길 경로 단서(git add 인자, commit -a, commit 경로)를 모은다.
// sh -c / bash -c / eval의 문자열과 git alias는 펼쳐서 다시 해석한다.
// 해석할 수 없는 형태(xargs git commit 같은)로 commit/push를 부르면 unparsed에 담는다.
export function findGitCalls(cmd, startDir, depth = 0) {
    const calls = [];
    const unparsed = [];
    let staged = { all: false, trackedOnly: false, paths: [] };
    let dir = startDir;
    for (const words of segments(cmd)) {
        const tokens = stripPrefixes(words);
        const head = tokens.length ? path.basename(tokens[0]) : "";
        if (head === "cd") {
            if (tokens[1]) dir = path.resolve(dir, expandHome(tokens[1]));
            continue;
        }
        const shellFlag = SHELLS.has(head) ? tokens.findIndex((token, index) => index > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(token)) : -1;
        if (depth < 3 && (head === "eval" || shellFlag > 0)) {
            const script = head === "eval" ? tokens.slice(1).join(" ") : tokens[shellFlag + 1] ?? "";
            const nested = findGitCalls(script, dir, depth + 1);
            for (const call of nested.calls) calls.push(call);
            unparsed.push(...nested.unparsed);
            continue;
        }
        if (head !== "git") {
            // git이 명령 자리가 아닌 곳에서 commit/push와 함께 실행 인자로 쓰였다 (xargs git commit, find -exec git push)
            const at = tokens.findIndex((token, index) => index > 0 && path.basename(token) === "git");
            if (at > 0 && tokens.slice(at + 1).some((token) => token === "commit" || token === "push")) unparsed.push(tokens.join(" "));
            continue;
        }
        let i = 1;
        let callDir = dir;
        while (i < tokens.length && tokens[i].startsWith("-")) {
            if (tokens[i] === "-C" && tokens[i + 1]) {
                callDir = path.resolve(callDir, expandHome(tokens[i + 1]));
                i += 2;
            } else if (["-c", "--git-dir", "--work-tree", "--namespace"].includes(tokens[i])) {
                i += 2;
            } else {
                i += 1;
            }
        }
        let sub = tokens[i];
        let args = tokens.slice(i + 1);
        if (sub && !GIT_SUBCOMMANDS.has(sub)) {
            const alias = gitAlias(callDir, sub);
            if (alias?.startsWith("!")) {
                if (/\b(commit|push)\b/.test(alias)) unparsed.push(`git ${sub} (alias: ${alias})`);
                continue;
            }
            if (alias) {
                const expanded = alias.split(/\s+/).filter(Boolean);
                sub = expanded[0];
                args = [...expanded.slice(1), ...args];
            }
        }
        if (sub === "add" || sub === "stage") {
            const paths = args.filter((a) => !a.startsWith("-"));
            if (args.some((a) => ["-u", "--update"].includes(a))) {
                staged.all = true;
            } else if (args.some((a) => ["-A", "--all"].includes(a)) || paths.some((p) => p === "." || p === ":/")) {
                staged.all = true;
                staged.trackedOnly = false; // untracked도 담는다
            }
            staged.paths.push(...paths.map((p) => path.relative(callDir, path.resolve(callDir, p))));
        } else if (sub === "commit") {
            const commitPaths = [];
            for (let j = 0; j < args.length; j++) {
                const a = args[j];
                if (a === "--") {
                    commitPaths.push(...args.slice(j + 1));
                    break;
                }
                if (a === "-a" || a === "--all" || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(a) && !a.startsWith("--")) {
                    staged.all = true;
                    staged.trackedOnly = true;
                }
                if (COMMIT_VALUE_OPTIONS.has(a) || /^-[a-zA-Z]*[mFCct]$/.test(a)) {
                    j++;
                    continue;
                }
                if (!a.startsWith("-")) commitPaths.push(a);
            }
            calls.push({ sub, args, dir: callDir, staged: { ...staged, paths: [...staged.paths, ...commitPaths.map((p) => path.relative(callDir, path.resolve(callDir, p)))] } });
            staged = { all: false, trackedOnly: false, paths: [] }; // 커밋이 담아 간 단서는 다음 커밋으로 넘기지 않는다
        } else if (sub === "push") {
            calls.push({ sub, args, dir: callDir });
        }
    }
    return { calls, unparsed };
}

// 이번 커밋에 실제로 담길 수 있는 변경만 고른다: index는 항상, 작업 트리는 add/commit 인자가 가리키는 것만
// root는 git이 돌려준 실제 경로이므로, callDir도 실제 경로로 바꿔야 상대 경로가 맞는다 (/var → /private/var 같은 심볼릭 링크).
export function commitCandidates(changes, staged, callDir, root) {
    const prefix = path.relative(root, realpathOr(callDir));
    const targets = staged.paths.map((p) => path.normalize(path.join(prefix, p)));
    const matches = (file) => targets.some((t) => t === "." || file === t || file.startsWith(`${t}/`));
    return changes.filter((change) => {
        if (change.where === "staged") return true;
        if (staged.all && !(staged.trackedOnly && change.untracked)) return true;
        return matches(change.path); // commit -a라도 git add로 직접 지정한 새 파일은 담긴다
    });
}

export function inProgressOperation(root) {
    for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
        if (existsSync(path.resolve(root, git(root, "rev-parse", "--git-path", name)))) return name;
    }
    return null;
}

export function isNonContentPush(args) {
    return args.some((arg) => arg === "--delete" || arg === "-d" || arg === "--tags" || /^:/.test(arg));
}

// ─── PreToolUse 게이트 ──────────────────────────────────────────────────────

const looksLikeCommitOrPush = (text) => /\bgit\b/.test(text) && /\b(commit|push)\b/.test(text);

function writeDecision(decision, reason) {
    process.stdout.write(
        `${JSON.stringify({
            hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason },
        })}\n`,
    );
    process.exit(0);
}

// PreToolUse(Bash) 훅 본체. 판단할 수 없을 때 조용히 통과시키지 않는다:
// - 훅 입력을 해석하지 못했는데 commit/push로 보이면 막는다
// - 변경을 확인하다 git이 실패하면 사용자에게 확인을 받는다
// - 해석할 수 없는 형태로 commit/push를 부르면 사용자에게 확인을 받는다
// onBlocked(call, blocked, what, scope)는 막을 때의 결정을 돌려준다: { decision, reason }
export function runGitGuard({ name, store, gateDisabled, onBlocked }) {
    let raw = "";
    let input;
    try {
        raw = readFileSync(0, "utf8");
        input = JSON.parse(raw);
    } catch {
        if (looksLikeCommitOrPush(raw)) {
            writeDecision("deny", `${name} 게이트가 훅 입력을 해석하지 못해 커밋·푸시인지 확인할 수 없습니다. 명령을 단순한 형태(git add … && git commit …)로 다시 실행하세요.`);
        }
        process.exit(0);
    }
    const command = String(input?.tool_input?.command ?? "");
    // alias(git ci 등)는 commit이라는 단어 없이도 커밋하므로 git만 보이면 해석한다
    if (!/\bgit\b/.test(command)) process.exit(0);
    if (gateDisabled("commit") && gateDisabled("push")) process.exit(0);

    const { calls, unparsed } = findGitCalls(command, input.cwd ?? process.cwd());
    for (const call of calls) {
        if (gateDisabled(call.sub)) continue;
        const root = repoRoot(call.dir);
        if (!root) continue;

        let blocked;
        try {
            if (call.sub === "commit") {
                if (inProgressOperation(root)) continue; // merge·cherry-pick·revert·rebase 중의 커밋은 다른 곳에서 온 내용이다
                blocked = store.unchecked(root, commitCandidates(pendingChanges(root), call.staged, call.dir, root));
            } else {
                if (isNonContentPush(call.args)) continue;
                blocked = store.unchecked(root, unpushedChanges(root));
            }
        } catch (error) {
            writeDecision(
                "ask",
                `${name} 게이트가 ${call.sub === "commit" ? "커밋" : "푸시"}할 변경을 확인하지 못했습니다 (${String(error?.message ?? error).split("\n")[0]}). 검사 없이 진행할까요?`,
            );
        }
        if (blocked.length === 0) continue;

        const what = call.sub === "commit" ? "커밋" : "푸시";
        const scope = call.sub === "commit" ? "커밋되지 않은 소스 변경" : "원격에 없는 커밋의 소스 변경";
        const { decision, reason } = onBlocked(call, blocked, what, scope);
        writeDecision(decision, reason);
    }

    if (unparsed.length > 0 && !(gateDisabled("commit") && gateDisabled("push"))) {
        const root = repoRoot(input.cwd ?? process.cwd());
        if (!root || !backstopInstalled(root)) {
            writeDecision(
                "ask",
                `${name} 게이트가 해석할 수 없는 형태로 커밋·푸시를 실행합니다 (${unparsed[0]}). 검사 없이 진행할까요? 단순한 git 명령으로 바꿔 실행하면 게이트가 검사합니다.`,
            );
        }
    }
    process.exit(0);
}

// ─── 위험도 ─────────────────────────────────────────────────────────────────

// 경로만으로 민감하다고 보는 파일: 인증·권한·서버 진입점·설정·의존성·배포
const SENSITIVE_PATH =
    /(^|\/)(auth|login|logout|signin|signup|session|token|oauth|jwt|crypto|secur|permission|acl|rbac|role|admin|middleware|proxy|api|routes?|server|handlers?|controllers?|webhooks?|payment|billing|checkout)([./_-]|$)/i;
const SENSITIVE_FILES =
    /(^|\/)(\.env[^/]*|package\.json|requirements[^/]*\.txt|pyproject\.toml|setup\.py|go\.mod|Cargo\.toml|Gemfile|composer\.json|build\.gradle(\.kts)?|Podfile|Dockerfile|docker-compose[^/]*\.ya?ml|AndroidManifest\.xml|Info\.plist|app\.json|app\.config\.[jt]s|(next|vite|nuxt)\.config\.[cm]?[jt]s|vercel\.json|netlify\.toml|firebase\.json|[^/]*\.rules|nginx[^/]*\.conf|\.npmrc|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|poetry\.lock|uv\.lock|Pipfile(\.lock)?|go\.sum|Cargo\.lock|Gemfile\.lock|composer\.lock)$|(^|\/)\.github\/workflows\//i;
// 추가된 줄에 나오면 민감하다고 보는 패턴: 인증·시크릿·위험한 싱크·네트워크·저장소
const SENSITIVE_CONTENT = new RegExp(
    [
        String.raw`passw(or)?d|secret|api[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|bearer|authorization|credential`,
        String.raw`\bjwt\b|\bsession\b|\bcookie|csrf|cors|oauth|signIn|signOut|\blogin\b`,
        String.raw`\beval\s*\(|new Function\s*\(|child_process|\bexec(Sync|File)?\s*\(|\bspawn(Sync)?\s*\(|subprocess|os\.system|shell\s*=\s*True`,
        String.raw`innerHTML|outerHTML|dangerouslySetInnerHTML|v-html|document\.write|bypassSecurityTrust`,
        String.raw`\b(SELECT|INSERT|UPDATE|DELETE)\b.+\b(FROM|INTO|SET|WHERE)\b|\.raw\s*\(|\$queryRaw|\bquery\s*\(\s*[\x60'"]`,
        String.raw`pickle\.loads?|yaml\.load\s*\(|deserializ|readFile\w*\s*\(.*req\.|path\.join\s*\(.*req\.`,
        String.raw`localStorage|sessionStorage|AsyncStorage|SecureStore|Keychain|MMKV`,
        String.raw`http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)|rejectUnauthorized|NODE_TLS_REJECT_UNAUTHORIZED|verify\s*=\s*False`,
        String.raw`\bredirect\s*\(|window\.location\s*=|Linking\.|deep ?link|postMessage|process\.env\.`,
        String.raw`\bpermission|\bisAdmin\b|\brole\b|\bowner(Id)?\b`,
    ].join("|"),
    "i",
);

const RISK_DEFAULTS = { trivialLines: 20, trivialFiles: 3 };

export const RISK_PLANS = {
    // 테스트: run(기존 테스트만 실행) | write(변경 파일 테스트 작성)
    // 보안: scan(자동 스캔 후 깨끗하면 자동 기록) | full(감사 에이전트)
    // 리뷰: skip(자동 생략 기록) | review(codex 기본 리뷰) | adversarial-review(설계까지 의심하는 리뷰)
    none: { tests: "run", audit: "none", review: "none" },
    trivial: { tests: "run", audit: "scan", review: "skip" },
    standard: { tests: "write", audit: "scan", review: "review" },
    sensitive: { tests: "write", audit: "full", review: "adversarial-review" },
};

export function riskMode() {
    const mode = (process.env.BATON_MODE ?? "auto").toLowerCase();
    return ["fast", "standard", "strict", "auto"].includes(mode) ? mode : "auto";
}

// 모드가 위험도를 바꾼다. fast도 민감한 변경은 낮추지 않는다.
function effectiveLevel(level, mode) {
    if (level === "none") return "none";
    if (mode === "strict") return "sensitive";
    if (mode === "fast") return level === "sensitive" ? "sensitive" : "trivial";
    if (mode === "standard") return level === "trivial" ? "standard" : level;
    return level;
}

// 지금 작업 트리 전체(추적 + untracked, .gitignore 제외)를 tree 객체로 만든다. 저장소 index는 건드리지 않는다.
export function snapshotTree(root) {
    const scratch = mkdtempSync(path.join(tmpdir(), "baton-index-"));
    const env = { GIT_INDEX_FILE: path.join(scratch, "index") };
    try {
        if (hasHead(root)) gitWith(root, ["read-tree", "HEAD"], { env });
        else gitWith(root, ["read-tree", "--empty"], { env });
        gitWith(root, ["add", "-A", "--", "."], { env });
        return gitWith(root, ["write-tree"], { env });
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}

// 이번에 올라갈 변경 전체(원격에 없는 커밋 + 미커밋 변경)의 시작점
export function shipBase(root) {
    return unpushedBase(root) ?? (hasHead(root) ? git(root, "rev-parse", "HEAD") : EMPTY_TREE);
}

function addedLines(root, base, tree, paths) {
    if (paths.length === 0) return [];
    const diff = git(root, "diff", "--no-color", "--no-ext-diff", "-U0", base, tree, "--", ...paths);
    return lines(diff).filter((line) => line.startsWith("+") && !line.startsWith("+++"));
}

// 이번 변경의 위험도를 판정한다. 결과는 { level, mode, effective, plan, reasons, stats }.
export function classifyRisk(root, { tree = snapshotTree(root), base = shipBase(root), limits = RISK_DEFAULTS } = {}) {
    const mode = riskMode();
    const reasons = [];
    const numstat = lines(git(root, "diff", "--numstat", "--no-renames", base, tree)).map((line) => {
        const [added, removed, file] = line.split("\t");
        return { file, added: Number(added) || 0, removed: Number(removed) || 0, binary: added === "-" };
    });
    const status = new Map(
        lines(git(root, "diff", "--name-status", "--no-renames", base, tree)).map((line) => {
            const [code, file] = line.split("\t");
            return [file, code];
        }),
    );

    const configLike = numstat.filter((entry) => SENSITIVE_FILES.test(entry.file));
    const source = numstat.filter((entry) => isSource(entry.file));
    const stats = {
        files: numstat.length,
        sourceFiles: source.length,
        sourceLines: source.reduce((sum, entry) => sum + entry.added + entry.removed, 0),
        newSourceFiles: source.filter((entry) => status.get(entry.file) === "A").length,
    };

    for (const entry of configLike) reasons.push(`설정·의존성·배포 파일 변경: ${entry.file}`);
    for (const entry of source) {
        if (SENSITIVE_PATH.test(entry.file) && !configLike.includes(entry)) reasons.push(`민감한 경로: ${entry.file}`);
    }
    const hits = addedLines(root, base, tree, source.filter((entry) => !entry.binary).map((entry) => entry.file))
        .map((line) => line.slice(1))
        .filter((line) => SENSITIVE_CONTENT.test(line));
    if (hits.length > 0) reasons.push(`민감한 코드 ${hits.length}줄 (예: ${hits[0].trim().slice(0, 80)})`);

    let level;
    if (source.length === 0 && configLike.length === 0) level = "none";
    else if (reasons.length > 0) level = "sensitive";
    else if (stats.sourceLines <= limits.trivialLines && stats.sourceFiles <= limits.trivialFiles) level = "trivial";
    else level = "standard";

    const effective = effectiveLevel(level, mode);
    return { level, mode, effective, plan: RISK_PLANS[effective], reasons, stats, base, tree };
}

// ─── 시크릿 자동 스캔 ───────────────────────────────────────────────────────

const SECRET_FILE =
    /(^|\/)(\.env($|\.)|.*\.(pem|key|p8|p12|pfx|jks|keystore|mobileprovision)$|id_(rsa|ed25519|ecdsa)$|credentials\.json$|service-account.*\.json$|google-services\.json$|GoogleService-Info\.plist$|\.npmrc$|\.pypirc$|\.netrc$)/i;
const SECRET_TEMPLATE = /\.(example|sample|template)$/i;
const SECRET_VALUE = [
    /AKIA[0-9A-Z]{16}/,
    /sk_live_[0-9A-Za-z]{8,}/,
    /sk-(proj-)?[A-Za-z0-9_-]{20,}/,
    /gh[pousr]_[A-Za-z0-9]{36}/,
    /xox[baprs]-[A-Za-z0-9-]{10,}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /AIza[0-9A-Za-z_-]{35}/,
    /(api[_-]?key|secret|password|passwd|token|client[_-]?secret|access[_-]?key)["']?\s*[:=]\s*["'][^"'\s$<{]{8,}["']/i,
];

// 감사 A절(저장소에 들어가면 안 되는 것)을 자동으로 확인한다. 하나라도 걸리면 자동 기록하지 않는다.
export function scanSecrets(root, { tree = snapshotTree(root), base = shipBase(root) } = {}) {
    const findings = [];
    for (const file of lines(git(root, "ls-tree", "-r", "--name-only", tree))) {
        if (SECRET_FILE.test(file) && !SECRET_TEMPLATE.test(file)) findings.push(`추적 중인 시크릿 파일: ${file}`);
    }
    for (const line of addedLines(root, base, tree, ["."])) {
        if (SECRET_VALUE.some((pattern) => pattern.test(line))) {
            findings.push(`시크릿으로 보이는 값: ${line.slice(1).trim().slice(0, 12)}••••`);
        }
    }
    return findings;
}

// ─── 리뷰 델타 ──────────────────────────────────────────────────────────────

const SYNTHETIC_IDENTITY = {
    GIT_AUTHOR_NAME: "baton",
    GIT_AUTHOR_EMAIL: "baton@localhost",
    GIT_COMMITTER_NAME: "baton",
    GIT_COMMITTER_EMAIL: "baton@localhost",
};

function treeEntry(root, tree, file) {
    const line = tryGit(root, "ls-tree", tree, "--", file);
    if (!line) return null;
    const [meta, ] = line.split("\t");
    const [mode, , hash] = meta.split(" ");
    return { mode, hash };
}

// 아직 통과하지 않은 내용만 diff로 보이는 두 커밋을 만든다.
// - reviewed(R): 지금 작업 트리에서, 통과하지 않은 소스 파일만 마지막 통과 내용(없으면 base 내용)으로 되돌린 상태
// - current(C): 지금 작업 트리 그대로. 부모가 R이라서 `R..C`가 곧 리뷰할 델타다.
// 이미 통과한 파일, 문서·에셋, 공백만 바뀐 파일은 델타에 나오지 않는다.
export function buildDelta(root, store, { tree = snapshotTree(root), base = shipBase(root) } = {}) {
    const { files: passed } = store.load(root);
    const changed = lines(git(root, "diff", "--name-only", "--no-renames", base, tree)).filter(isSource);
    const overrides = [];
    const reviewFiles = [];
    for (const file of changed) {
        const current = treeEntry(root, tree, file);
        const change = { path: file, hash: current?.hash ?? DELETED, where: "unpushed" };
        if (store.isPassed(root, change, passed)) continue;
        reviewFiles.push(file);
        const previous = [...(passed[file] ?? [])].reverse().find((hash) => hash === DELETED || tryGit(root, "cat-file", "-e", hash) !== null);
        const fallback = base === EMPTY_TREE ? null : treeEntry(root, base, file);
        const target = previous === undefined ? fallback : previous === DELETED ? null : { mode: current?.mode ?? fallback?.mode ?? "100644", hash: previous };
        overrides.push(target ? `${target.mode} ${target.hash}\t${file}` : `0 ${"0".repeat(40)}\t${file}`);
    }
    if (reviewFiles.length === 0) return { empty: true, files: [] };

    const scratch = mkdtempSync(path.join(tmpdir(), "baton-delta-index-"));
    const env = { GIT_INDEX_FILE: path.join(scratch, "index"), ...SYNTHETIC_IDENTITY };
    let reviewedTree;
    try {
        gitWith(root, ["read-tree", tree], { env });
        gitWith(root, ["update-index", "--index-info"], { env, input: `${overrides.join("\n")}\n` });
        reviewedTree = gitWith(root, ["write-tree"], { env });
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
    const parent = hasHead(root) ? ["-p", "HEAD"] : [];
    const reviewed = gitWith(root, ["commit-tree", reviewedTree, ...parent, "-m", "baton: 이미 리뷰한 내용"], { env: SYNTHETIC_IDENTITY });
    const current = gitWith(root, ["commit-tree", tree, "-p", reviewed, "-m", "baton: 아직 리뷰하지 않은 변경"], { env: SYNTHETIC_IDENTITY });
    const stat = git(root, "diff", "--shortstat", reviewed, current);
    return { empty: false, files: reviewFiles, reviewed, current, stat };
}

// ─── git 훅 백스톱 ──────────────────────────────────────────────────────────

const BACKSTOP_MARK = "# baton-gate-backstop";
const BACKSTOP_HOOKS = ["pre-commit", "pre-push"];

function backstopScript(hook) {
    return `#!/bin/sh
${BACKSTOP_MARK} (review·security 플러그인이 설치함)
# Claude Code가 실행한 커밋·푸시만 검사한다. 사람이 터미널에서 하는 커밋은 막지 않는다.
# PreToolUse 훅이 해석하지 못한 형태(스크립트, alias 등)로 실행된 커밋·푸시를 잡는 2차 방어선이다.
[ "$CLAUDECODE" = "1" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0
roots="\${BATON_PLUGIN_ROOTS:-}"
cache="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache"
${hook === "pre-push" ? 'input=$(cat)\n' : ""}for plugin in review security; do
  script=""
  if [ -n "$roots" ]; then
    script=$(printf '%s\\n' "$roots" | tr ':' '\\n' | while read -r dir; do [ -f "$dir/$plugin/hooks/git-backstop.mjs" ] && echo "$dir/$plugin/hooks/git-backstop.mjs"; done | head -1)
  else
    script=$(ls -d "$cache"/*/"$plugin"/*/hooks/git-backstop.mjs 2>/dev/null | sort -V | tail -1)
  fi
  [ -n "$script" ] || continue
  ${hook === "pre-push" ? `printf '%s\\n' "$input" | node "$script" ${hook} "$@" || exit 1` : `node "$script" ${hook} "$@" || exit 1`}
done
exit 0
`;
}

function hooksDir(root) {
    return path.resolve(root, git(root, "rev-parse", "--git-path", "hooks"));
}

export function backstopInstalled(root) {
    try {
        return BACKSTOP_HOOKS.every((hook) => readFileSync(path.join(hooksDir(root), hook), "utf8").includes(BACKSTOP_MARK));
    } catch {
        return false;
    }
}

// 기존 훅이나 훅 관리 도구(core.hooksPath: husky 등)가 있으면 덮어쓰지 않는다. 결과를 한 줄로 돌려준다.
export function installBackstop(root) {
    if (process.env.BATON_BACKSTOP === "0") return null;
    if (tryGit(root, "config", "--get", "core.hooksPath")) return "core.hooksPath를 쓰는 저장소라 git 훅 백스톱을 설치하지 않았습니다.";
    const dir = hooksDir(root);
    const installed = [];
    const skipped = [];
    for (const hook of BACKSTOP_HOOKS) {
        const file = path.join(dir, hook);
        const existing = existsSync(file) ? readFileSync(file, "utf8") : null;
        if (existing !== null && !existing.includes(BACKSTOP_MARK)) {
            skipped.push(hook);
            continue;
        }
        const script = backstopScript(hook);
        if (existing === script) continue;
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, script, { mode: 0o755 });
        installed.push(hook);
    }
    const parts = [];
    if (installed.length) parts.push(`git 훅 백스톱을 설치했습니다 (${installed.join(", ")}). Claude Code가 실행한 커밋·푸시만 검사합니다.`);
    if (skipped.length) parts.push(`기존 ${skipped.join(", ")} 훅이 있어 백스톱을 설치하지 않았습니다.`);
    return parts.join(" ") || null;
}

// git 훅에서 실행된다. 막으면 1, 통과하면 0을 돌려준다. 확인하지 못하면 경고만 하고 통과시킨다 (1차 방어선은 PreToolUse 훅이다).
export function runBackstop({ name, store, gateDisabled, howToFix, hook }) {
    if (process.env.CLAUDECODE !== "1") return 0;
    const kind = hook === "pre-commit" ? "commit" : "push";
    if (gateDisabled(kind)) return 0;
    const root = repoRoot(process.cwd());
    if (!root) return 0;
    let blocked = [];
    try {
        if (hook === "pre-commit") {
            if (inProgressOperation(root)) return 0;
            // git이 넘긴 GIT_INDEX_FILE을 그대로 쓰므로 commit -a, commit <경로>도 실제로 담길 내용을 본다
            blocked = store.unchecked(root, pendingChanges(root).filter((change) => change.where === "staged"));
        } else {
            const zero = /^0+$/;
            for (const line of lines(readFileSync(0, "utf8"))) {
                const [, localSha, , remoteSha] = line.split(" ");
                if (!localSha || zero.test(localSha)) continue;
                let base = remoteSha && !zero.test(remoteSha) && tryGit(root, "cat-file", "-e", `${remoteSha}^{commit}`) !== null ? remoteSha : null;
                if (!base) {
                    const commits = lines(git(root, "rev-list", "--reverse", localSha, "--not", "--remotes"));
                    if (commits.length === 0) continue;
                    base = tryGit(root, "rev-parse", "-q", "--verify", `${commits[0]}^`) ?? EMPTY_TREE;
                }
                blocked.push(...store.unchecked(root, rangeChanges(root, base, localSha)));
            }
        }
    } catch (error) {
        process.stderr.write(`[${name}] git 훅 백스톱이 변경을 확인하지 못해 통과시킵니다: ${String(error?.message ?? error).split("\n")[0]}\n`);
        return 0;
    }
    if (blocked.length === 0) return 0;
    process.stderr.write(
        `[${name}] ${name}를 통과하지 않은 소스 변경이 있어 ${kind === "commit" ? "커밋" : "푸시"}할 수 없습니다: ${describe(blocked)}.\n${howToFix}\n` +
            "(사람이 직접 실행한 커밋이면 --no-verify로 건너뛸 수 있습니다.)\n",
    );
    return 1;
}
