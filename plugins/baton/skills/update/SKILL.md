---
name: update
description: baton 마켓플레이스 목록을 갱신하고, 설치된 baton 플러그인을 범위(user·project·local)와 프로젝트에 상관없이 모두 업데이트한다. 사용자가 "baton 업데이트", "플러그인 업데이트해줘", "baton 최신으로"라고 할 때 사용한다.
argument-hint: "[--dry-run]"
allowed-tools: Bash
---

# baton 플러그인 한 번에 업데이트

이 스킬 폴더 기준 `../../scripts/update.mjs`를 실행한다. 인자로 `--dry-run`을 받았으면 그대로 넘긴다.

```
node "<이 스킬 폴더>/../../scripts/update.mjs" [--dry-run]
```

스크립트가 하는 일:
1. `claude plugin marketplace update baton`으로 목록을 갱신한다.
2. `claude plugin list --json`에서 `@baton` 설치를 찾아, 범위마다 `claude plugin update <id> -s <범위>`를 실행한다. project·local 범위는 그 프로젝트 폴더에서 실행한다.
3. 설치했던 프로젝트 폴더가 사라진 설치는 건너뛰고 목록으로 알린다.

## 마칠 때

- 업데이트·실패·건너뜀 수를 한 줄로 보고하고, 실패한 항목은 출력의 오류와 함께 적는다.
- 건너뛴 설치가 있으면 폴더를 옮겼거나 지운 것이라고 알리고, user 범위로 다시 설치하면(`claude plugin install all@baton -s user`) 프로젝트마다 따로 업데이트할 일이 없다고 적는다. 설치를 지우거나 다시 설치하는 것은 사용자가 원할 때만 한다.
- 새 버전은 **사용자가 `/reload-plugins`를 실행하거나 Claude Code를 재시작해야** 적용된다고 마지막 줄에 적는다. Claude는 슬래시 명령을 실행할 수 없다.
