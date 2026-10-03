# 포터블 API 클라이언트 설계

## 목적

회사 방화벽 때문에 Postman 등 API 테스트 도구를 설치·다운로드할 수 없는 PC에서 쓸 Postman 대체 도구.
폴더째 들고 다니며 설치 없이 실행한다.

## 전제

- 대상 PC: Windows, Node.js 18 이상이 항상 설치되어 있음.
- npm 패키지를 쓰지 않는다. `node_modules` 없이 Node 내장 모듈만 사용.
- exe 배포는 하지 않는다. 서명 없는 exe 는 사내 보안 프로그램에 차단될 가능성이 높다. 필요해지면 Node SEA 빌드 스크립트만 추가한다 (`server.js` 변경 불필요).

## 파일 구성

```
vibe-dev-tools/
  server.js    — 정적 파일 서빙, /api/send, /api/data, Postman 변환, 시작 시 앱 창 오픈
  index.html   — 화면 (HTML + CSS + JS 한 파일)
  실행.bat     — `node server.js` (더블클릭 실행용)
  test.js      — `node --test` 로 실행하는 테스트
  data.json    — 컬렉션·환경·히스토리·설정 (첫 실행 시 생성, git 제외)
```

## 실행 흐름

1. `node server.js` 또는 `실행.bat` 실행.
2. 서버가 `127.0.0.1` 의 빈 포트에 뜬다 (포트 지정 없이 OS 할당).
3. 서버가 Edge 를 `--app=<url>` 로 띄워 주소창 없는 독립 창으로 연다. Edge 가 없으면 Chrome `--app`, 둘 다 없으면 기본 브라우저.
4. 콘솔 창을 닫으면 종료.

## 기능 (첫 버전 전체)

1. 기본 요청·응답: 메서드, URL, Params(쿼리), Headers, Body. 응답의 상태 코드·소요 시간·크기·헤더·본문(JSON 이면 정렬 표시).
2. 인증: 없음 / Bearer / Basic. 서버에서 `Authorization` 헤더로 변환.
3. Body 종류: none / JSON / form-data(텍스트·파일 행) / x-www-form-urlencoded / raw.
4. 컬렉션: 폴더와 요청의 트리. 저장·이름 변경·삭제.
5. 환경변수: 여러 환경 중 하나를 선택. `{{이름}}` 을 URL·Params·Headers·Body·Auth 값에서 치환.
6. 히스토리: 보낸 요청 자동 기록, 최근 100건 유지. 클릭하면 다시 불러온다.
7. Postman 가져오기: Postman Collection v2.0 / v2.1 JSON.
8. 설정: SSL 검증 무시(기본 꺼짐), 타임아웃(기본 30초).
- 요청 전송은 `node:http` / `node:https` 로 한다. 내장 `fetch` 는 npm 패키지(undici) 없이 SSL 검증 무시를 설정할 수 없다. multipart 본문은 내장 `FormData` 를 `new Response(formData)` 로 직렬화해 만든다.

제외 (요청 시 추가): 요청 여러 개를 탭으로 동시에 열기, pre-request·테스트 스크립트 실행, 쿠키 저장소, 프록시(`HTTP_PROXY`).

## 화면 구성

```
┌──────────────────┬───────────────────────────────────────────────────────┐
│ [컬렉션][히스토리]│  환경: [개발 ▼]  [환경 편집]  [⚙]      [Postman 가져오기] │
│ ▼ 주문 API       ├───────────────────────────────────────────────────────┤
│    GET 목록       │ [GET ▼] [ {{baseUrl}}/orders?page=1         ] [보내기] [저장]│
│    POST 생성      │ [Params] [Headers] [Auth] [Body]                      │
│ ▶ 회원 API       │  key / value / 사용 체크 표                             │
│ + 새 폴더         ├───────────────────────────────────────────────────────┤
│                  │ 200 OK · 132 ms · 2.1 KB        [Body] [Headers]      │
│                  │ { "items": [...], "total": 42 }                       │
└──────────────────┴───────────────────────────────────────────────────────┘
```

- Params 탭과 URL 쿼리스트링은 양방향 동기화.
- 환경 편집은 모달. 환경 추가/삭제와 변수 key/value 표 편집.

## 서버 API

모든 `/api/*` 요청은 `X-Token` 헤더에 서버 시작 시 생성한 랜덤 토큰이 있어야 한다. 없거나 틀리면 403.
토큰은 `index.html` 을 서빙할 때 페이지에 주입한다.

### `POST /api/send`

요청 본문:
```json
{
  "method": "POST",
  "url": "{{baseUrl}}/orders",
  "params":  [{ "key": "page", "value": "1", "enabled": true }],
  "headers": [{ "key": "X-A", "value": "b", "enabled": true }],
  "auth": { "type": "none | bearer | basic", "token": "", "username": "", "password": "" },
  "body": {
    "type": "none | json | form | urlencoded | raw",
    "raw": "문자열 (json, raw)",
    "fields": [{ "key": "f", "type": "text | file", "value": "텍스트", "fileName": "a.png", "fileBase64": "..." , "enabled": true }]
  },
  "variables": { "baseUrl": "http://..." },
  "settings": { "insecure": false, "timeoutMs": 30000 }
}
```
- 파일은 화면에서 선택한 파일을 base64 로 실어 보낸다 (경로 접근 불필요).

응답 본문 (성공):
```json
{ "ok": true, "status": 200, "statusText": "OK", "timeMs": 132, "size": 2150,
  "headers": [["content-type", "application/json"]], "body": "...", "truncated": false }
```
응답 본문 (실패):
```json
{ "ok": false, "error": { "code": "ECONNREFUSED", "message": "연결이 거부되었습니다", "hint": "" } }
```

### `GET /api/data`, `PUT /api/data`

`data.json` 전체를 읽고 쓴다.
```json
{
  "version": 1,
  "collections": [{ "id": "", "name": "", "type": "folder", "children": [] }],
  "environments": [{ "id": "", "name": "", "variables": [{ "key": "", "value": "", "enabled": true }] }],
  "activeEnvironmentId": null,
  "history": [{ "at": "ISO8601", "request": {}, "status": 200, "timeMs": 132 }],
  "settings": { "insecure": false, "timeoutMs": 30000 }
}
```
- 컬렉션의 요청 노드는 `{ "id", "name", "type": "request", "request": <send 요청 본문에서 variables·settings 를 뺀 것> }`.
- 히스토리 100건 제한은 화면에서 적용 후 저장.

### `POST /api/import/postman`

Postman 컬렉션 JSON 을 받아 내부 컬렉션 노드로 변환해 돌려준다. 저장은 화면이 `PUT /api/data` 로 한다.
응답: `{ "ok": true, "collection": <폴더 노드>, "skipped": 3 }`.

## 에러 처리

요청 실행:
- 요청 실패 시 서버는 죽지 않고 `ok: false` 와 코드·메시지를 돌려준다. 구분 대상: `ECONNREFUSED`, `ENOTFOUND`, 타임아웃, SSL 인증서 오류(힌트: "SSL 검증 무시를 켜보세요").
- 잘못된 URL, 정의되지 않은 `{{변수}}` 는 전송 전에 거부하고 해당 변수 이름을 알려준다.
- 파일 행의 base64 가 비었거나 잘못되면 파일명과 함께 거부.
- 응답 본문이 10MB 를 넘으면 앞 10MB 만 돌려주고 `truncated: true`.

저장:
- `data.json` 이 없으면 빈 구조로 생성.
- JSON 파싱 실패 시 `data.json.broken-<yyyyMMdd-HHmmss>` 로 이름을 바꿔 보존하고 빈 구조로 시작, 화면에 경고.
- 쓰기는 `data.json.tmp` 에 쓴 뒤 rename. 실패하면 화면에 오류를 띄우고 화면 상태는 유지.

Postman 가져오기:
- `info.schema` 가 v2.0 / v2.1 이 아니면 거부.
- pre-request·test 스크립트 등 미지원 항목은 건너뛰고 개수를 `skipped` 로 보고.

보안:
- `127.0.0.1` 에만 바인딩.
- 토큰 불일치 403.

## 테스트

`test.js` 하나, `node --test test.js` 로 실행. 테스트 안에서 로컬 에코 서버와 `server.js` 를 띄워 검증한다.

- `{{변수}}` 치환, 정의 안 된 변수 거부
- Bearer / Basic 헤더 생성
- JSON / form-data(텍스트+파일) / urlencoded / raw 전송
- 토큰 없는 요청 403
- Postman v2.1 샘플 변환과 skipped 개수
- 깨진 `data.json` 보존 후 재생성

화면은 자동 테스트 없이 실제로 띄워 수동 확인한다.
