# Shuttle Spike (`shuttle-spike`)

P0 플랫폼 검증용 일회성 Obsidian 플러그인이다(설계 §7.9, §10.2). 배포하지 않는다.

> **실제 볼트에는 절대 설치하지 않는다.** 이 플러그인은 볼트 안에 시험 파일을 만들고 지우며, `app.json`을 잠시 바꾸고, 수백 MiB를 IndexedDB와 디스크에 쓴다. 기기마다 빈 시험용 볼트(예: `shuttle-test`)를 새로 만들어 그 볼트에만 넣는다. 파일이 500개 넘는 볼트에서 켜면 경고 알림이 뜬다. 무거운 프로브는 볼트 파일이 500개 이하이고 볼트 이름에 `test`, `sandbox`, `scratch`, `spike` 중 하나가 들어 있을 때만 확인 창 하나로 돈다. 그 밖의 볼트에서는 기본으로 거부하고, 볼트 이름을 그대로 입력해야만 실행된다.

## 빌드

```sh
cd ~/projects/shuttle
source scripts/env.sh
node scripts/build.mjs spike        # dist/spike/{main.js,manifest.json,styles.css}
```

P0-C2는 `@shuttle/crypto`의 `selfTest`를 쓰므로 워크스페이스에 crypto 패키지가 있어야 빌드된다.

## 시험 볼트에 설치(사이드로드)

공통: 시험 볼트를 만들고 Obsidian 설정에서 커뮤니티 플러그인(제한 모드 해제)을 켠 뒤 `dist/spike/`의 세 파일을 `<시험 볼트>/.obsidian/plugins/shuttle-spike/`에 넣는다. 그다음 커뮤니티 플러그인 목록에서 "Shuttle Spike"를 켠다. 기기의 설정 폴더 이름이 `.obsidian`이 아니면 그 이름을 쓴다.

| 기기 | 방법 |
|---|---|
| Mac | `cp -R dist/spike/ "<시험 볼트>/.obsidian/plugins/shuttle-spike/"` 후 Obsidian에서 플러그인 목록 새로고침 |
| iPhone, iPad | 시험 볼트를 "나의 iPhone/iPad" 위치(iCloud 아님)에 만든다. 파일 앱에서 `Obsidian/<시험 볼트>/.obsidian/plugins/shuttle-spike/` 폴더를 만들고 세 파일을 복사한다. 파일 앱은 점으로 시작하는 폴더를 숨기므로, 막히면 Mac에서 AirDrop으로 폴더째 보내거나 Mac의 Finder(기기 연결 후 파일 탭)로 넣는다 |
| Android (Fold) | USB 디버깅 연결 후 `adb push dist/spike /sdcard/Documents/<시험 볼트>/.obsidian/plugins/shuttle-spike` (볼트 위치에 맞게 경로 수정) |
| redroid (Android 에뮬레이터) | `adb -s 127.0.0.1:5555 push dist/spike <볼트 경로>/.obsidian/plugins/shuttle-spike` |

BRAT 설치는 나중에 GitHub pre-release가 생기면 쓴다(비공개 저장소 토큰 지원은 UNVERIFIED).

디버깅: Android는 `chrome://inspect`, iOS는 Safari 웹 속성(릴리스 빌드에서 되는지는 UNVERIFIED). 콘솔을 못 열어도 결과 노트가 남는다.

## 사용

- 명령 팔레트에서 "Shuttle Spike: Run all safe probes"를 실행한다(리본의 플라스크 아이콘도 같다). 안전한 프로브만 차례로 돌고, 서버가 필요한 M4~M7은 서버가 3초 안에 `/v1/health`에 답하지 않으면 `skipped`로 남는다.
- 프로브마다 따로 명령이 있다(`M4: ...`, `P0-C2: ...`). "(heavy, asks first)"가 붙은 명령은 확인 창을 띄우고 끝나면 스스로 만든 파일과 DB를 지운다: M11(IndexedDB 200 MiB), M13b(app.json 토글 후 원래 바이트로 복원), M14, M15/M16(50 MiB 파일), M18-corpus(노트 4,000개), M22(rename over), M24-reload, M7-idle.
- "(interactive)"는 사용자 동작이 필요한 프로브다: M8은 켠 뒤 다른 앱으로 5초 넘게 나갔다 돌아오면 결과가 기록된다. M23은 아이콘이 바뀌는지 묻는다.
- 기록형 프로브: M9(앱 전환, 잠금, 복귀 후 다시 실행), M12와 M21(강제 종료나 플러그인 끄고 켜기 후 다시 실행), M19(결과 노트의 `obsidian://shuttle-enroll` 링크를 다른 앱에서 열고 다시 실행).
- "Crypto self-test and benchmark (P0-C1..C11)" 명령은 암호 프로브만 돈다.
- 플러그인을 켤 때(레이아웃 준비 후) 지난 세션이 강제 종료로 남긴 것을 정리한다: `_shuttle-spike/tmp/` 아래 파일 전부(M15/M16의 50 MiB 숨김 파일, M18 corpus 노트), IndexedDB `shuttle-spike-m10`과 `shuttle-spike-m11`. M13b는 바꾸기 전에 원래 `app.json`, `hotkeys.json`, `appearance.json`을 `_shuttle-spike/tmp/restore/`에 저장하고, 남아 있으면 다음 시작 때 되돌린다. 정리한 내용은 결과 노트의 `cleanup` 행에 남는다.

## 결과

- 시험 볼트의 `_shuttle-spike/results-<기기>-<yyyymmdd-hhmm>.md`에 기기 정보(Platform, navigator.userAgent, Obsidian 버전), 결과 표, JSON이 함께 쓰인다. 플러그인을 켤 때마다 새 파일이 생기고, 같은 세션 안에서는 프로브를 다시 돌리면 그 행이 갱신된다.
- 설정 탭의 "Copy results" 버튼이나 "Copy results" 명령으로 클립보드에 복사한다. 클립보드가 막히면 텍스트 창이 뜬다.
- 시험 파일은 `_shuttle-spike/tmp/` 아래에만 만든다.

## 설정

| 항목 | 기본값 |
|---|---|
| Server URL | 비어 있음. 테스트할 서버 주소를 직접 입력합니다. 서버에 닿지 않아 서버 프로브가 `skipped`가 되면 일괄 실행 알림에 그 프로브 이름이 나온다 |
| Device name | 비우면 플랫폼 기본값(iPhone, iPad, Android phone, Mac 등) |
| M7 idle hold | 10분 |
| Post results | 꺼짐. 켜면 `POST /v1/dev/spike`로 보낸다(P0 스텁에는 아직 이 경로가 없다) |

## 지금 스텁으로는 확인되지 않는 것

- M5: 스텁은 기본으로 블롭을 4 MiB+1 KiB로 막고 팩 엔드포인트가 없다. M5와 N5는 스텁을 `SHUTTLE_MAX_BLOB=8650752`로 띄워 돌린다. 8 MiB PUT이 2xx이거나 `fromShuttle=true`인 413이면 DSM이 본문을 통과시킨 것이므로 pass, `fromShuttle=false`인 413은 프록시(DSM) 한도라 fail이다.
- M6: 스텁은 304를 보내지 않으므로 200 대체 경로만 기록된다.
- M8: 스텁에 레코드가 없어 재연결과 welcome까지만 잰다(100건 catch-up은 UNVERIFIED).
- M20: 골든 파일은 `src/probes/dmp-goldens.json`이고 Node에서 `packages/testkit/dmpGoldens.test.ts`가 만들고 검사한다(`SHUTTLE_UPDATE_GOLDENS=1`로 다시 만든다). 엔진 DMP 대신 §3.10.2의 merge3를 그대로 옮긴 `src/probes/dmp-cases.ts`를 쓴다.
- P0-C8: Argon2id(hash-wasm)는 넣지 않았다. Blob URL Worker와 64 MiB WASM 메모리만 확인한다. v1은 PBKDF2를 기본으로 두므로 Argon2id 측정은 미뤘다(`docs/p0-results.md`).
