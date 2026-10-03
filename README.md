# vibe-dev-tools

설치 없이 폴더째 들고 다니며 쓰는 포터블 API 클라이언트입니다. 방화벽 때문에 Postman 같은 도구를 설치할 수 없는 PC에서 쓰려고 만들었습니다.

- npm 패키지를 쓰지 않습니다. Node.js 내장 모듈만 쓰므로 `npm install`이 필요 없습니다.
- 주소창 없는 Edge(또는 Chrome) 앱 창으로 열립니다.
- 데이터는 이 폴더의 `data.json` 한 파일에 저장됩니다.

## 요구 사항

- Windows
- Node.js 18 이상

## 실행

`실행.bat`을 더블클릭합니다. 서버가 콘솔 창 없이 뒤에서 뜨고, 앱 창이 열립니다.

```
node server.js
```

이렇게 콘솔에서 실행하면 서버 로그를 바로 볼 수 있습니다.

- 서버는 `127.0.0.1`의 빈 포트에서만 받습니다.
- 앱 창을 닫고 약 90초가 지나면 서버도 스스로 종료됩니다.
- `실행.bat`으로 띄웠다면 서버 출력은 `server.log`에 남습니다.

## 기능

- **요청·응답**: 메서드, URL, Params(URL 쿼리와 양방향 동기화), Headers, Body를 입력합니다. 응답의 상태 코드, 소요 시간, 크기, 헤더, 본문을 보여줍니다(JSON은 정렬해서 표시).
- **인증**: 없음, Bearer, Basic
- **Body 종류**: none, JSON, form-data(텍스트·파일), x-www-form-urlencoded, raw
- **컬렉션**: 폴더와 요청을 트리로 저장하고, 이름을 바꾸거나 지웁니다.
- **환경변수**: 여러 환경 중 하나를 고르면 URL, Params, Headers, Body, Auth 안의 `{{이름}}`이 치환됩니다.
- **히스토리**: 보낸 요청이 최근 100건까지 기록됩니다.
- **Postman 가져오기**: Collection v2.0 / v2.1 JSON을 가져옵니다. pre-request·test 스크립트는 건너뜁니다.
- **설정**: SSL 검증 무시(기본 꺼짐), 타임아웃(기본 30초)

## 보안

- `127.0.0.1`에만 바인딩합니다.
- 모든 `/api/*` 호출에는 서버가 시작할 때 만든 랜덤 토큰이 필요합니다.
- `Host` 헤더가 `127.0.0.1:<포트>`가 아니면 요청을 거부합니다(DNS 리바인딩 차단).

## 테스트

```
node --test test.js
```

## 파일 구성

| 파일 | 내용 |
|---|---|
| `server.js` | 로컬 서버, 요청 전송, 데이터 저장, Postman 변환, 앱 창 열기 |
| `index.html` | 화면 (HTML·CSS·JS 한 파일) |
| `실행.bat` | 더블클릭 실행용 |
| `test.js` | 테스트 |
| `fonts/` | JetBrains Mono, D2Coding, Pretendard (각 라이선스 파일 포함) |
| `samples/test-apis.json` | 공개 테스트 API로 기능을 확인하는 예제 컬렉션 (Postman 가져오기로 불러옵니다) |
| `data.json` | 컬렉션·환경·히스토리·설정. 첫 실행 때 생기며 git에서 제외됩니다 |

설계 문서는 [docs/superpowers/specs/2026-10-03-api-client-design.md](docs/superpowers/specs/2026-10-03-api-client-design.md)에 있습니다.
