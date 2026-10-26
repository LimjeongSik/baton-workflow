---
name: usage
description: 세션의 토큰·시간·호출 수를 transcript에서 실측해 보여 준다. 모델별·서브에이전트별 토큰, 도구·스킬 호출 수, codex 리뷰 횟수와 시간, 게이트에 막힌 횟수, git:ship 단계 기록을 낸다. 사용자가 "토큰 얼마나 썼어", "비용 확인", "어디서 시간이 오래 걸렸어", "usage"라고 할 때, 또는 git:ship·feature:build 보고에 비용 한 줄을 붙일 때 사용한다.
argument-hint: "[--session <id> | --since YYYY-MM-DD] [--json]"
allowed-tools: Bash
---

# 사용량 실측

이 스킬 폴더 기준 `../../scripts/usage.mjs`를 실행한다. 인자는 그대로 넘긴다.

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/usage.mjs" $ARGUMENTS
```

- 인자가 없으면 지금 폴더의 가장 최근 세션(보통 지금 세션)을 본다.
- 출력을 그대로 보여 주고, 눈에 띄는 것을 한두 줄로 짚는다. 예: 서브에이전트 비중이 크면 작은 작업에 에이전트를 여럿 띄웠는지, codex 리뷰가 여러 번이면 델타 리뷰가 아닌 `--full`로 돌았는지, 게이트에 여러 번 막혔으면 감사·리뷰 뒤에 소스를 고쳤는지.
- 숫자는 transcript에 기록된 실측값이다. 금액으로 바꾸지 않는다 (요금은 플랜과 시점마다 다르다). codex 자체의 토큰은 transcript에 없어서 횟수와 시간만 나온다.
- 다른 스킬의 보고에 붙일 때는 한 줄로 줄인다: `사용량: 메인 출력 12k · 서브에이전트 3개(전체의 40%) · codex 1회 2.1분 · 게이트 막힘 0회`.
