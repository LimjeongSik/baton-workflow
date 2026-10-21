# baton

설치된 baton 플러그인을 범위(user·project·local)와 프로젝트에 상관없이 한 번에 업데이트합니다.

## 설치

```
/plugin install baton@baton
```

Claude Code 2.1.275 이상에서는 `/plugin install baton --marketplace LimjeongSik/baton-workflow` 한 줄로도 됩니다. `all`로 설치했다면 `all`을 0.4.0 이상으로 업데이트하면 함께 설치됩니다.

## 사용법

```
/baton:update            # 목록 갱신 후 설치된 baton 플러그인을 모두 업데이트
/baton:update --dry-run  # 실행할 명령만 보여 줌
```

"baton 업데이트해줘"처럼 말해도 됩니다. 끝나면 `/reload-plugins`를 실행하거나 Claude Code를 재시작해야 새 버전이 적용됩니다.

## 하는 일

1. `claude plugin marketplace update baton`으로 마켓플레이스 목록을 갱신합니다.
2. `claude plugin list --json`에서 `@baton` 설치를 찾아 범위마다 `claude plugin update <이름>@baton -s <범위>`를 실행합니다. project·local 범위는 그 프로젝트 폴더에서 실행합니다.
3. 설치했던 프로젝트 폴더를 옮겼거나 지웠으면 그 설치는 건너뛰고 목록으로 알려 줍니다. 설치를 지우거나 다시 설치하지는 않습니다.

터미널에서는 `node ~/.claude/plugins/marketplaces/baton/plugins/baton/scripts/update.mjs`로 같은 일을 합니다.
