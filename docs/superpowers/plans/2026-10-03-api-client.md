# 포터블 API 클라이언트 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 방화벽 PC 에서 설치 없이 `node server.js` 로 띄우는 Postman 대체 API 클라이언트를 만든다.

**Architecture:** `server.js` 가 `127.0.0.1` 의 빈 포트에서 `index.html` 을 서빙하고, 화면 대신 `node:http`/`node:https` 로 실제 요청을 보내며(CORS 회피), `data.json` 에 컬렉션·환경·히스토리를 저장한다. 서버는 시작하면 Edge `--app` 창을 띄운다. 화면은 프레임워크 없는 HTML 한 파일이다.

**Tech Stack:** Node.js 18+ 내장 모듈(`http`, `https`, `fs`, `crypto`, `child_process`, `node:test`), 바닐라 HTML/CSS/JS.

**Spec:** `docs/superpowers/specs/2026-10-03-api-client-design.md`

## Global Constraints

- Node.js 18 이상. npm 패키지 금지 (`package.json`, `node_modules` 없음).
- 요청 전송은 `node:http` / `node:https`. 내장 `fetch` 는 서버 쪽 전송에 쓰지 않는다 (SSL 검증 무시 불가).
- 서버는 `127.0.0.1` 에만 바인딩, 포트는 0(OS 할당).
- 모든 `/api/*` 는 `X-Token` 헤더 토큰 필요, `Host` 가 `127.0.0.1:<포트>` 가 아니면 403.
- 응답 본문 10MB 초과분 잘라냄, 요청 본문 50MB 초과 413, 기본 타임아웃 30000ms, 히스토리 100건.
- 화면 문구·주석은 한국어. 주석은 스펙(보장·이유)만 적는다.
- 커밋 메시지는 무엇을 왜 바꿨는지 한 줄, 도구가 만든 흔적(Co-Authored-By 등) 금지. 브랜치는 `main` 하나.
- 사용자 데이터를 화면에 넣을 때는 `textContent` 만 쓴다 (`innerHTML` 금지 — 응답 본문에 HTML 이 들어올 수 있다).

## Review Focus

1. Headers 에 소문자 `content-type` 을 직접 넣은 JSON 요청 → Content-Type 이 하나만 나가고 사용자 값이 유지된다. (Task 1 테스트)
2. Headers 에 `Authorization` 을 넣고 Auth 탭도 Bearer → Auth 탭 값 하나만 나간다. (Task 1 테스트)
3. 변수 값 안에 `{{...}}` 가 있음 → 재귀 치환하지 않고 문자 그대로 보낸다. (Task 1 테스트)
4. 다른 도메인 이름으로 들어온 요청(DNS 리바인딩) → 토큰이 든 페이지도 주지 않고 403. (Task 5 테스트)
5. 잘못된 JSON·50MB 초과 본문 → 400/413 을 돌려주고 서버는 다음 요청에 정상 응답. (Task 5 테스트)

---

## File Structure

| 파일 | 책임 |
|---|---|
| `server.js` | 요청 조립·전송, 데이터 저장, Postman 변환, HTTP 서버, 앱 창 실행. 함수들을 `module.exports` 로 내보내 테스트한다 |
| `test.js` | `node --test test.js`. 에코 서버를 띄워 `server.js` 를 검증 |
| `index.html` | 화면 전체 (HTML + CSS + JS) |
| `실행.bat` | 더블클릭 실행용 |
| `.gitattributes` | `.bat` 를 CRLF 로 유지 |

`server.js` 는 Task 1~5 에 걸쳐 함수를 덧붙인다. 각 Task 는 새 코드를 **`module.exports` 줄 바로 위**에 넣고, `module.exports` 줄을 Task 에 적힌 것으로 바꾼다.

---

### Task 1: 요청 조립 (변수 치환·params·인증·본문)

**Files:**
- Create: `server.js`
- Create: `test.js`

**Interfaces:**
- Produces:
  - `class RequestError extends Error { code: string; hint: string }`
  - `substitute(text: string, vars: Record<string,string>): string` — 정의 안 된 변수면 `RequestError('UNDEFINED_VARIABLE')`
  - `async buildRequest(spec) → { method: string, url: URL, headers: Record<string,string>, body: Buffer|null }`
  - `spec` 형식은 스펙 문서 `POST /api/send` 요청 본문과 같다.

- [ ] **Step 1: 실패하는 테스트 작성** — `test.js` 생성

```js
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  RequestError, substitute, buildRequest, sendRequest, toError,
  loadData, saveData, convertPostman, createServer,
} = require('./server.js');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

test('substitute: 변수를 치환하고, 정의 안 된 변수는 이름과 함께 거부한다', () => {
  assert.equal(substitute('{{a}}/x/{{ b }}', { a: '1', b: '2' }), '1/x/2');
  assert.throws(() => substitute('{{nope}}', {}), { code: 'UNDEFINED_VARIABLE', message: /nope/ });
});

test('substitute: 값 안의 {{...}} 는 다시 치환하지 않는다', () => {
  assert.equal(substitute('{{a}}', { a: '{{b}}' }), '{{b}}');
});

test('buildRequest: params 를 URL 뒤에 붙이고 비활성·빈 행은 뺀다', async () => {
  const r = await buildRequest({
    method: 'get',
    url: '{{base}}/a',
    params: [
      { key: 'q', value: '한 글', enabled: true },
      { key: 'off', value: '1', enabled: false },
      { key: '', value: '', enabled: true },
    ],
    variables: { base: 'http://h' },
  });
  assert.equal(r.method, 'GET');
  assert.equal(r.url.href, 'http://h/a?q=%ED%95%9C+%EA%B8%80');
  assert.equal(r.body, null);
});

test('buildRequest: 잘못된 URL 과 http/https 외 프로토콜은 거부한다', async () => {
  await assert.rejects(buildRequest({ url: 'not a url' }), { code: 'INVALID_URL' });
  await assert.rejects(buildRequest({ url: 'file:///c:/x' }), { code: 'INVALID_URL' });
});

test('buildRequest: Bearer / Basic 인증은 Authorization 헤더 하나로 만든다', async () => {
  const bearer = await buildRequest({
    url: 'http://h',
    headers: [{ key: 'authorization', value: 'old', enabled: true }],
    auth: { type: 'bearer', token: '{{t}}' },
    variables: { t: 'abc' },
  });
  assert.deepEqual(bearer.headers, { Authorization: 'Bearer abc' });
  const basic = await buildRequest({ url: 'http://h', auth: { type: 'basic', username: 'u', password: 'p' } });
  assert.equal(basic.headers.Authorization, 'Basic dTpw');
});

test('buildRequest: JSON 본문은 사용자가 넣은 Content-Type 을 유지한다', async () => {
  const auto = await buildRequest({ method: 'POST', url: 'http://h', body: { type: 'json', raw: '{"a":"{{v}}"}' }, variables: { v: '1' } });
  assert.equal(auto.body.toString(), '{"a":"1"}');
  assert.equal(auto.headers['Content-Type'], 'application/json');
  const custom = await buildRequest({
    method: 'POST', url: 'http://h',
    headers: [{ key: 'content-type', value: 'application/vnd.x+json', enabled: true }],
    body: { type: 'json', raw: '{}' },
  });
  assert.deepEqual(custom.headers, { 'content-type': 'application/vnd.x+json' });
});

test('buildRequest: urlencoded / form-data 직렬화', async () => {
  const form = { type: 'urlencoded', fields: [{ key: 'a', value: '1', enabled: true }, { key: 'b', value: '가', enabled: true }] };
  const enc = await buildRequest({ method: 'POST', url: 'http://h', body: form });
  assert.equal(enc.body.toString(), 'a=1&b=%EA%B0%80');
  assert.equal(enc.headers['Content-Type'], 'application/x-www-form-urlencoded');

  const multi = await buildRequest({
    method: 'POST', url: 'http://h',
    headers: [{ key: 'Content-Type', value: 'text/plain', enabled: true }],
    body: { type: 'form', fields: [
      { key: 't', type: 'text', value: 'v', enabled: true },
      { key: 'f', type: 'file', fileName: 'a.txt', fileBase64: 'aGVsbG8=', enabled: true },
    ] },
  });
  assert.match(multi.headers['Content-Type'], /^multipart\/form-data; boundary=/);
  assert.equal(Object.keys(multi.headers).length, 1);
  const text = multi.body.toString();
  assert.match(text, /name="f"; filename="a.txt"/);
  assert.match(text, /hello/);
});

test('buildRequest: 파일 내용이 비었거나 base64 가 아니면 파일명과 함께 거부한다', async () => {
  const bad = (fileBase64) => buildRequest({
    method: 'POST', url: 'http://h',
    body: { type: 'form', fields: [{ key: 'f', type: 'file', fileName: 'a.txt', fileBase64, enabled: true }] },
  });
  await assert.rejects(bad(''), { code: 'INVALID_FILE', message: /a\.txt/ });
  await assert.rejects(bad('@@@'), { code: 'INVALID_FILE' });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `node --test test.js`
Expected: FAIL — `Cannot find module './server.js'`

- [ ] **Step 3: 구현** — `server.js` 생성

```js
'use strict';
// 포터블 API 클라이언트 서버. Node 18 이상, npm 패키지 없이 내장 모듈만 사용한다.
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

// 화면에 원인을 보여줄 수 있는 실패. code 는 화면과 테스트가 실패 종류를 구분하는 데 쓴다.
class RequestError extends Error {
  constructor(code, message, hint = '') {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

// 비활성 행과 key 가 빈 행(화면의 입력용 빈 줄)은 보내지 않는다.
const enabledRows = (rows) => (rows || []).filter((r) => r.enabled !== false && r.key);

// {{이름}} 을 vars 값으로 바꾼다. 한 번만 치환하므로 값 안의 {{...}} 는 그대로 남는다.
function substitute(text, vars) {
  return String(text ?? '').replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (match, name) => {
    if (!Object.hasOwn(vars, name)) throw new RequestError('UNDEFINED_VARIABLE', `정의되지 않은 변수: ${name}`, '환경 편집에서 변수를 추가하거나 환경을 선택하세요');
    return vars[name];
  });
}

function deleteHeader(headers, name) {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) delete headers[key];
  }
}

const hasHeader = (headers, name) => Object.keys(headers).some((key) => key.toLowerCase() === name);

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function decodeFile(field) {
  if (!field.fileBase64 || !BASE64.test(field.fileBase64)) {
    throw new RequestError('INVALID_FILE', `파일을 읽을 수 없습니다: ${field.fileName || field.key}`, '파일을 다시 선택하세요');
  }
  return Buffer.from(field.fileBase64, 'base64');
}

// 화면이 보낸 요청 명세를 실제 전송할 형태로 만든다. 전송 전에 잡을 수 있는 오류는 여기서 RequestError 로 던진다.
async function buildRequest(spec) {
  const vars = spec.variables || {};
  const sub = (text) => substitute(text, vars);

  const rawUrl = sub(spec.url);
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new RequestError('INVALID_URL', `잘못된 URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RequestError('INVALID_URL', `http/https URL 만 보낼 수 있습니다: ${rawUrl}`);
  }
  for (const p of enabledRows(spec.params)) url.searchParams.append(sub(p.key), sub(p.value));

  const headers = {};
  for (const h of enabledRows(spec.headers)) headers[sub(h.key)] = sub(h.value);

  // Auth 탭을 고르면 Headers 탭의 Authorization 보다 우선한다.
  const auth = spec.auth || {};
  if (auth.type === 'bearer') {
    deleteHeader(headers, 'authorization');
    headers.Authorization = `Bearer ${sub(auth.token)}`;
  } else if (auth.type === 'basic') {
    deleteHeader(headers, 'authorization');
    headers.Authorization = `Basic ${Buffer.from(`${sub(auth.username)}:${sub(auth.password)}`).toString('base64')}`;
  }

  const defaultType = (type) => {
    if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = type;
  };
  const b = spec.body || {};
  let body = null;
  if (b.type === 'json' || b.type === 'raw') {
    body = Buffer.from(sub(b.raw));
    defaultType(b.type === 'json' ? 'application/json' : 'text/plain');
  } else if (b.type === 'urlencoded') {
    const form = new URLSearchParams();
    for (const f of enabledRows(b.fields)) form.append(sub(f.key), sub(f.value));
    body = Buffer.from(form.toString());
    defaultType('application/x-www-form-urlencoded');
  } else if (b.type === 'form') {
    const form = new FormData();
    for (const f of enabledRows(b.fields)) {
      if (f.type === 'file') form.append(sub(f.key), new Blob([decodeFile(f)]), f.fileName);
      else form.append(sub(f.key), sub(f.value));
    }
    // multipart 경계(boundary)는 직렬화할 때 정해지므로 사용자가 넣은 Content-Type 은 버린다.
    const serialized = new Response(form);
    body = Buffer.from(await serialized.arrayBuffer());
    deleteHeader(headers, 'content-type');
    headers['Content-Type'] = serialized.headers.get('content-type');
  }

  return { method: String(spec.method || 'GET').toUpperCase(), url, headers, body };
}

module.exports = { RequestError, substitute, buildRequest };
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `node --test test.js`
Expected: 8개 테스트 모두 PASS

- [ ] **Step 5: 커밋**

```bash
git add server.js test.js
git commit -m "요청 조립: 변수 치환, params, 인증, 본문 직렬화"
```

---

### Task 2: 요청 전송과 오류 변환

**Files:**
- Modify: `server.js` (`module.exports` 위에 추가, exports 교체)
- Modify: `test.js` (끝에 추가)

**Interfaces:**
- Consumes: `buildRequest(spec)`, `RequestError`
- Produces:
  - `async sendRequest(spec) → { ok: true, status, statusText, timeMs, size, headers: [string,string][], body: string, truncated: boolean }` — 실패하면 throw
  - `toError(err) → { code: string, message: string, hint: string }`
  - 상수 `DEFAULT_TIMEOUT_MS = 30000`

- [ ] **Step 1: 실패하는 테스트 작성** — `test.js` 끝에 추가

```js
// 받은 요청을 JSON 으로 그대로 돌려주는 서버. /slow 는 응답하지 않고, /big 은 11MB 를 보낸다.
async function startEcho() {
  const server = http.createServer((req, res) => {
    if (req.url === '/slow') return;
    if (req.url === '/big') return res.end(Buffer.alloc(11 * 1024 * 1024, 97));
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
  });
  const base = await listen(server);
  return { base, close() { server.closeAllConnections(); server.close(); } };
}

let echo;
before(async () => { echo = await startEcho(); });
after(() => echo.close());

test('sendRequest: 요청을 보내고 상태·헤더·본문·시간을 돌려준다', async () => {
  const r = await sendRequest({
    method: 'POST',
    url: `${echo.base}/x`,
    params: [{ key: 'q', value: '1', enabled: true }],
    headers: [{ key: 'X-A', value: '{{v}}', enabled: true }],
    body: { type: 'json', raw: '{"a":1}' },
    variables: { v: 'b' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(typeof r.timeMs, 'number');
  assert.equal(r.truncated, false);
  assert.ok(r.headers.some(([k]) => k.toLowerCase() === 'content-type'));
  const echoed = JSON.parse(r.body);
  assert.equal(echoed.method, 'POST');
  assert.equal(echoed.url, '/x?q=1');
  assert.equal(echoed.headers['x-a'], 'b');
  assert.equal(echoed.headers['content-length'], '7');
  assert.equal(echoed.body, '{"a":1}');
});

test('sendRequest: form-data 로 텍스트와 파일을 보낸다', async () => {
  const r = await sendRequest({
    method: 'POST',
    url: `${echo.base}/upload`,
    body: { type: 'form', fields: [
      { key: 't', type: 'text', value: 'v', enabled: true },
      { key: 'f', type: 'file', fileName: 'a.txt', fileBase64: 'aGVsbG8=', enabled: true },
    ] },
  });
  const echoed = JSON.parse(r.body);
  assert.match(echoed.headers['content-type'], /^multipart\/form-data; boundary=/);
  assert.match(echoed.body, /filename="a.txt"/);
  assert.match(echoed.body, /hello/);
});

test('sendRequest: 타임아웃이 지나면 TIMEOUT 으로 실패한다', async () => {
  await assert.rejects(sendRequest({ url: `${echo.base}/slow`, settings: { timeoutMs: 200 } }), { code: 'TIMEOUT' });
});

test('sendRequest: 10MB 넘는 응답은 앞 10MB 만 돌려준다', async () => {
  const r = await sendRequest({ url: `${echo.base}/big` });
  assert.equal(r.truncated, true);
  assert.equal(r.size, 11 * 1024 * 1024);
  assert.equal(r.body.length, 10 * 1024 * 1024);
});

test('toError: 연결 거부·SSL 오류·RequestError 를 화면용 메시지로 바꾼다', async () => {
  const closed = http.createServer();
  const base = await listen(closed);
  await new Promise((resolve) => closed.close(resolve));
  const err = await sendRequest({ url: base }).catch((e) => e);
  assert.deepEqual(toError(err), { code: 'ECONNREFUSED', message: '연결이 거부되었습니다', hint: '서버 주소와 포트를 확인하세요' });
  const ssl = Object.assign(new Error('self signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
  assert.equal(toError(ssl).hint, 'SSL 검증 무시를 켜보세요');
  assert.deepEqual(toError(new RequestError('UNDEFINED_VARIABLE', 'x', 'y')), { code: 'UNDEFINED_VARIABLE', message: 'x', hint: 'y' });
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test.js`
Expected: 새 5개 FAIL — `sendRequest is not a function`

- [ ] **Step 3: 구현** — `server.js` 의 `module.exports` 위에 추가

```js
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 화면이 멈추지 않도록 응답 본문은 10MB 까지만 돌려준다
const DEFAULT_TIMEOUT_MS = 30000;

// 요청을 보내고 응답 전체를 모은다. 연결 실패·타임아웃은 reject 하고, HTTP 오류 상태(4xx/5xx)는 정상 응답으로 돌려준다.
// 리다이렉트는 따라가지 않고 3xx 응답을 그대로 보여준다.
async function sendRequest(spec) {
  const settings = spec.settings || {};
  const timeoutMs = Number.isFinite(settings.timeoutMs) && settings.timeoutMs > 0 ? settings.timeoutMs : DEFAULT_TIMEOUT_MS;
  const { method, url, headers, body } = await buildRequest(spec);
  if (body) headers['Content-Length'] = body.length;
  const lib = url.protocol === 'https:' ? https : http;
  const started = performance.now();

  return new Promise((resolve, reject) => {
    let response = null;
    const req = lib.request(url, { method, headers, rejectUnauthorized: !settings.insecure }, (res) => {
      response = res;
      const chunks = [];
      let size = 0;
      let kept = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (kept < MAX_RESPONSE_BYTES) {
          const part = chunk.subarray(0, MAX_RESPONSE_BYTES - kept);
          chunks.push(part);
          kept += part.length;
        }
      });
      res.on('error', fail);
      res.on('end', () => {
        clearTimeout(timer);
        const pairs = [];
        for (let i = 0; i < res.rawHeaders.length; i += 2) pairs.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);
        resolve({
          ok: true,
          status: res.statusCode,
          statusText: res.statusMessage,
          timeMs: Math.round(performance.now() - started),
          size,
          headers: pairs,
          body: Buffer.concat(chunks).toString('utf8'),
          truncated: size > MAX_RESPONSE_BYTES,
        });
      });
    });
    // 타이머는 연결부터 응답 본문 끝까지 전체 시간을 잰다.
    const timer = setTimeout(() => {
      const err = new RequestError('TIMEOUT', `${timeoutMs}ms 안에 응답이 끝나지 않았습니다`, '설정에서 타임아웃을 늘려보세요');
      req.destroy(err);
      response?.destroy(err);
    }, timeoutMs);
    function fail(err) {
      clearTimeout(timer);
      reject(err);
    }
    req.on('error', fail);
    req.end(body ?? undefined);
  });
}

const SSL_ERROR_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID',
]);

// 화면에 보여줄 { code, message, hint } 로 바꾼다.
function toError(err) {
  if (err instanceof RequestError) return { code: err.code, message: err.message, hint: err.hint };
  if (err.code === 'ECONNREFUSED') return { code: err.code, message: '연결이 거부되었습니다', hint: '서버 주소와 포트를 확인하세요' };
  if (err.code === 'ENOTFOUND') return { code: err.code, message: '호스트를 찾을 수 없습니다', hint: '주소 철자와 사내망 연결을 확인하세요' };
  if (SSL_ERROR_CODES.has(err.code)) return { code: err.code, message: `SSL 인증서 오류: ${err.message}`, hint: 'SSL 검증 무시를 켜보세요' };
  return { code: err.code || 'ERROR', message: err.message, hint: '' };
}
```

`module.exports` 줄 교체:

```js
module.exports = { RequestError, substitute, buildRequest, sendRequest, toError };
```

- [ ] **Step 4: 통과 확인**

Run: `node --test test.js`
Expected: 13개 모두 PASS

- [ ] **Step 5: 커밋**

```bash
git add server.js test.js
git commit -m "요청 전송: 타임아웃, 10MB 응답 제한, 오류 메시지 변환"
```

---

### Task 3: 데이터 저장 (data.json)

**Files:**
- Modify: `server.js`
- Modify: `test.js`

**Interfaces:**
- Consumes: `RequestError`, `DEFAULT_TIMEOUT_MS`
- Produces:
  - `loadData(file: string) → { data, warning: string|null }` — 없으면 빈 구조, 깨졌으면 `<file>.broken-<yyyyMMdd-HHmmss>` 로 보존 후 빈 구조와 경고
  - `saveData(file: string, data)` — 형식이 틀리면 `RequestError('INVALID_DATA')`, `<file>.tmp` 에 쓰고 rename

- [ ] **Step 1: 실패하는 테스트 작성** — `test.js` 끝에 추가

```js
function tempDataFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-client-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'data.json');
}

test('loadData: 파일이 없으면 빈 구조를 돌려준다', (t) => {
  const { data, warning } = loadData(tempDataFile(t));
  assert.deepEqual(data, {
    version: 1, collections: [], environments: [], activeEnvironmentId: null, history: [],
    settings: { insecure: false, timeoutMs: 30000 },
  });
  assert.equal(warning, null);
});

test('loadData: 깨진 파일은 .broken-<시각> 으로 보존하고 새로 시작한다', (t) => {
  const file = tempDataFile(t);
  fs.writeFileSync(file, '{ 깨짐');
  const { data, warning } = loadData(file);
  assert.deepEqual(data.collections, []);
  assert.match(warning, /data\.json\.broken-\d{8}-\d{6}/);
  assert.equal(fs.existsSync(file), false);
  const kept = fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith('data.json.broken-'));
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(file), kept[0]), 'utf8'), '{ 깨짐');
});

test('saveData: 저장 후 다시 읽히고, 빠진 필드는 기본값으로 채운다', (t) => {
  const file = tempDataFile(t);
  const folder = { id: '1', name: 'f', type: 'folder', children: [] };
  saveData(file, { collections: [folder], settings: { insecure: true } });
  const { data } = loadData(file);
  assert.deepEqual(data.collections, [folder]);
  assert.deepEqual(data.history, []);
  assert.deepEqual(data.settings, { insecure: true, timeoutMs: 30000 });
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('saveData: 형식이 틀리면 거부하고 기존 파일을 건드리지 않는다', (t) => {
  const file = tempDataFile(t);
  saveData(file, { history: [] });
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => saveData(file, { history: 'x' }), { code: 'INVALID_DATA' });
  assert.throws(() => saveData(file, [1, 2]), { code: 'INVALID_DATA' });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test.js`
Expected: 새 4개 FAIL — `loadData is not a function`

- [ ] **Step 3: 구현** — `server.js` 의 `module.exports` 위에 추가

```js
const emptyData = () => ({
  version: 1,
  collections: [],
  environments: [],
  activeEnvironmentId: null,
  history: [],
  settings: { insecure: false, timeoutMs: DEFAULT_TIMEOUT_MS },
});

// 저장·로드가 받아들이는 최소 형태. 있는 필드만 형식을 확인하고 빠진 필드는 기본값으로 채운다.
function validateData(data) {
  const ok = data && typeof data === 'object' && !Array.isArray(data)
    && ['collections', 'environments', 'history'].every((key) => data[key] === undefined || Array.isArray(data[key]))
    && (data.settings === undefined || (data.settings && typeof data.settings === 'object' && !Array.isArray(data.settings)));
  if (!ok) throw new RequestError('INVALID_DATA', '저장할 데이터 형식이 올바르지 않습니다');
}

function withDefaults(data) {
  const empty = emptyData();
  return { ...empty, ...data, settings: { ...empty.settings, ...data.settings } };
}

function timestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

// 사용자 데이터를 조용히 덮어쓰지 않도록, 읽을 수 없는 파일은 지우지 않고 이름을 바꿔 남긴다.
function loadData(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { data: emptyData(), warning: null };
    throw err;
  }
  try {
    const data = JSON.parse(text);
    validateData(data);
    return { data: withDefaults(data), warning: null };
  } catch {
    const kept = `${file}.broken-${timestamp()}`;
    fs.renameSync(file, kept);
    return { data: emptyData(), warning: `data.json 을 읽을 수 없어 ${path.basename(kept)} 로 보관하고 새로 시작합니다` };
  }
}

// 임시 파일에 다 쓴 뒤 rename 하므로, 쓰는 도중 끊겨도 기존 data.json 은 온전하다.
function saveData(file, data) {
  validateData(data);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(withDefaults(data), null, 2));
  fs.renameSync(tmp, file);
}
```

`module.exports` 줄 교체:

```js
module.exports = { RequestError, substitute, buildRequest, sendRequest, toError, loadData, saveData };
```

- [ ] **Step 4: 통과 확인**

Run: `node --test test.js`
Expected: 17개 모두 PASS

- [ ] **Step 5: 커밋**

```bash
git add server.js test.js
git commit -m "데이터 저장: 원자적 쓰기, 손상 파일 보존"
```

---

### Task 4: Postman 컬렉션 변환

**Files:**
- Modify: `server.js`
- Modify: `test.js`

**Interfaces:**
- Consumes: `RequestError`
- Produces: `convertPostman(json) → { collection: <folder 노드>, skipped: number }` — v2.0/v2.1 이 아니면 `RequestError('UNSUPPORTED_POSTMAN')`
- 노드 형식: 폴더 `{ id, name, type: 'folder', children }`, 요청 `{ id, name, type: 'request', request: { method, url, params, headers, auth: { type, token, username, password }, body: { type, raw, fields } } }`

- [ ] **Step 1: 실패하는 테스트 작성** — `test.js` 끝에 추가

```js
const POSTMAN_SAMPLE = {
  info: { name: '주문 API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  event: [{ listen: 'prerequest', script: { exec: [''] } }],
  item: [
    {
      name: '주문',
      item: [
        {
          name: '목록',
          event: [{ listen: 'test', script: { exec: [''] } }],
          request: {
            method: 'GET',
            header: [{ key: 'Accept', value: 'application/json' }, { key: 'X-Off', value: '1', disabled: true }],
            url: { raw: '{{baseUrl}}/orders?page=1', query: [{ key: 'page', value: '1' }] },
            auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] },
          },
        },
        {
          name: '생성',
          request: {
            method: 'POST',
            url: '{{baseUrl}}/orders',
            body: { mode: 'raw', raw: '{"a":1}', options: { raw: { language: 'json' } } },
          },
        },
      ],
    },
    {
      name: '업로드',
      request: {
        method: 'post',
        url: { raw: 'http://h/u' },
        auth: { type: 'basic', basic: [{ key: 'username', value: 'u' }, { key: 'password', value: 'p' }] },
        body: { mode: 'formdata', formdata: [{ key: 't', value: 'v', type: 'text' }, { key: 'f', src: 'C:/a.png', type: 'file' }] },
      },
    },
  ],
};

test('convertPostman: 폴더·요청·params·헤더·인증·본문을 변환하고 건너뛴 항목을 센다', () => {
  const { collection, skipped } = convertPostman(POSTMAN_SAMPLE);
  assert.equal(skipped, 3); // 스크립트 2개 + 파일 필드 1개
  assert.equal(collection.type, 'folder');
  assert.equal(collection.name, '주문 API');

  const [folder, upload] = collection.children;
  assert.equal(folder.name, '주문');
  const [list, create] = folder.children;
  assert.equal(list.type, 'request');
  assert.deepEqual(list.request.params, [{ key: 'page', value: '1', enabled: true }]);
  assert.equal(list.request.url, '{{baseUrl}}/orders');
  assert.deepEqual(list.request.headers, [
    { key: 'Accept', value: 'application/json', enabled: true },
    { key: 'X-Off', value: '1', enabled: false },
  ]);
  assert.deepEqual(list.request.auth, { type: 'bearer', token: '{{token}}', username: '', password: '' });

  assert.equal(create.request.method, 'POST');
  assert.deepEqual(create.request.body, { type: 'json', raw: '{"a":1}', fields: [] });

  assert.equal(upload.request.method, 'POST');
  assert.deepEqual(upload.request.auth, { type: 'basic', token: '', username: 'u', password: 'p' });
  assert.deepEqual(upload.request.body.fields, [{ key: 't', value: 'v', enabled: true, type: 'text' }]);
});

test('convertPostman: v2.0 의 문자열 URL 과 객체형 인증 값도 읽는다', () => {
  const { collection } = convertPostman({
    info: { name: 'old', schema: 'https://schema.getpostman.com/json/collection/v2.0.0/collection.json' },
    item: [{ name: 'r', request: { url: 'http://h/a?x=1&y', method: 'GET', auth: { type: 'bearer', bearer: { token: 't' } } } }],
  });
  const { request } = collection.children[0];
  assert.equal(request.url, 'http://h/a');
  assert.deepEqual(request.params, [{ key: 'x', value: '1', enabled: true }, { key: 'y', value: '', enabled: true }]);
  assert.equal(request.auth.token, 't');
});

test('convertPostman: v2 형식이 아니면 거부한다', () => {
  assert.throws(() => convertPostman({ info: { schema: 'https://schema.getpostman.com/json/collection/v1.0.0/' } }), { code: 'UNSUPPORTED_POSTMAN' });
  assert.throws(() => convertPostman(null), { code: 'UNSUPPORTED_POSTMAN' });
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test.js`
Expected: 새 3개 FAIL — `convertPostman is not a function`

- [ ] **Step 3: 구현** — `server.js` 의 `module.exports` 위에 추가

```js
const POSTMAN_SCHEMA = /\/collection\/v2\.[01]\.0\//;

const blankRequest = () => ({
  method: 'GET',
  url: '',
  params: [],
  headers: [],
  auth: { type: 'none', token: '', username: '', password: '' },
  body: { type: 'none', raw: '', fields: [] },
});

const postmanRows = (list) => (Array.isArray(list) ? list : []).map((x) => ({ key: x.key ?? '', value: x.value ?? '', enabled: !x.disabled }));

// v2.1 은 [{ key, value }] 배열, v2.0 은 { key: value } 객체로 인증 값을 담는다.
const postmanAuthValue = (values, key) => (Array.isArray(values) ? values.find((x) => x.key === key)?.value : values?.[key]) ?? '';

function parseQuery(query) {
  return query.split('&').filter(Boolean).map((pair) => {
    const i = pair.indexOf('=');
    return { key: i < 0 ? pair : pair.slice(0, i), value: i < 0 ? '' : pair.slice(i + 1), enabled: true };
  });
}

// Postman Collection v2.0 / v2.1 을 내부 컬렉션 노드로 바꾼다. 스크립트·파일 필드·미지원 인증/본문은 건너뛰고 skipped 로 센다.
function convertPostman(json) {
  if (!POSTMAN_SCHEMA.test(json?.info?.schema || '')) {
    throw new RequestError('UNSUPPORTED_POSTMAN', 'Postman Collection v2.0 / v2.1 형식만 가져올 수 있습니다', 'Postman 에서 Export → Collection v2.1 로 내보내세요');
  }
  const state = { skipped: 0 };
  const collection = convertPostmanFolder(json.info.name || 'Postman', json, state);
  return { collection, skipped: state.skipped };
}

function convertPostmanFolder(name, folder, state) {
  state.skipped += (folder.event || []).length;
  const children = (folder.item || []).map((child) => (Array.isArray(child.item)
    ? convertPostmanFolder(child.name || '폴더', child, state)
    : convertPostmanItem(child, state)));
  return { id: crypto.randomUUID(), name, type: 'folder', children };
}

function convertPostmanItem(item, state) {
  state.skipped += (item.event || []).length;
  return { id: crypto.randomUUID(), name: item.name || '요청', type: 'request', request: convertPostmanRequest(item.request, state) };
}

function convertPostmanRequest(source, state) {
  const request = blankRequest();
  // v2.0 은 request 자리에 URL 문자열만 둘 수 있다.
  const r = typeof source === 'string' ? { url: source } : source;
  if (!r) return request;

  request.method = String(r.method || 'GET').toUpperCase();
  const raw = typeof r.url === 'string' ? r.url : r.url?.raw || '';
  const q = raw.indexOf('?');
  request.url = q < 0 ? raw : raw.slice(0, q);
  request.params = r.url && typeof r.url === 'object' ? postmanRows(r.url.query) : parseQuery(q < 0 ? '' : raw.slice(q + 1));
  request.headers = postmanRows(r.header);

  const auth = r.auth;
  if (auth?.type === 'bearer') {
    request.auth.type = 'bearer';
    request.auth.token = postmanAuthValue(auth.bearer, 'token');
  } else if (auth?.type === 'basic') {
    request.auth.type = 'basic';
    request.auth.username = postmanAuthValue(auth.basic, 'username');
    request.auth.password = postmanAuthValue(auth.basic, 'password');
  } else if (auth && auth.type !== 'noauth') {
    state.skipped += 1;
  }

  const body = r.body;
  if (body?.mode === 'raw') {
    request.body = { type: body.options?.raw?.language === 'json' ? 'json' : 'raw', raw: body.raw || '', fields: [] };
  } else if (body?.mode === 'urlencoded') {
    request.body = { type: 'urlencoded', raw: '', fields: postmanRows(body.urlencoded) };
  } else if (body?.mode === 'formdata') {
    // 파일 내용은 Postman 내보내기에 들어 있지 않으므로 파일 필드는 가져오지 않는다.
    const all = body.formdata || [];
    const texts = all.filter((f) => f.type !== 'file');
    state.skipped += all.length - texts.length;
    request.body = { type: 'form', raw: '', fields: postmanRows(texts).map((f) => ({ ...f, type: 'text' })) };
  } else if (body?.mode) {
    state.skipped += 1;
  }
  return request;
}
```

`module.exports` 줄 교체:

```js
module.exports = { RequestError, substitute, buildRequest, sendRequest, toError, loadData, saveData, convertPostman };
```

- [ ] **Step 4: 통과 확인**

Run: `node --test test.js`
Expected: 20개 모두 PASS

- [ ] **Step 5: 커밋**

```bash
git add server.js test.js
git commit -m "Postman v2.0/v2.1 컬렉션 가져오기"
```

---

### Task 5: 로컬 HTTP 서버, 앱 창 실행, 실행.bat

**Files:**
- Modify: `server.js`
- Modify: `test.js`
- Create: `실행.bat`
- Create: `.gitattributes`

**Interfaces:**
- Consumes: `sendRequest`, `toError`, `loadData`, `saveData`, `convertPostman`, `RequestError`
- Produces:
  - `createServer({ dataFile, token, indexFile? }) → http.Server` (listen 하지 않은 상태)
  - 라우트: `GET /` (index.html 의 `__TOKEN__` 을 토큰으로 치환), `POST /api/send`, `GET|PUT /api/data`, `POST /api/import/postman`
  - 응답 형식: 성공 `{ ok: true, ... }`, 실패 `{ ok: false, error: { code, message, hint } }`. `/api/send` 의 요청 실패는 200 + `ok: false`.
  - `index.html` 은 `const TOKEN = '__TOKEN__';` 로 토큰을 받는다.

- [ ] **Step 1: 실패하는 테스트 작성** — `test.js` 끝에 추가

```js
async function startApp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-client-'));
  const indexFile = path.join(dir, 'index.html');
  fs.writeFileSync(indexFile, '<script>const TOKEN = "__TOKEN__";</script>');
  const server = createServer({ dataFile: path.join(dir, 'data.json'), token: 'test-token', indexFile });
  const base = await listen(server);
  t.after(() => {
    server.closeAllConnections();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const call = (method, url, body, token = 'test-token') => fetch(base + url, {
    method,
    headers: { 'X-Token': token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { base, call };
}

function requestWithHost(url, host) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
}

test('server: 페이지에 토큰을 넣어 준다', async (t) => {
  const { base } = await startApp(t);
  const html = await (await fetch(`${base}/`)).text();
  assert.equal(html, '<script>const TOKEN = "test-token";</script>');
});

test('server: 토큰이 틀리거나 Host 가 다르면 403', async (t) => {
  const { base, call } = await startApp(t);
  assert.equal((await call('GET', '/api/data', undefined, 'wrong')).status, 403);
  assert.equal(await requestWithHost(`${base}/`, 'evil.example'), 403);
  assert.equal(await requestWithHost(`${base}/`, `localhost:${new URL(base).port}`), 403);
});

test('server: 데이터를 저장하고 다시 읽는다, 형식이 틀리면 400', async (t) => {
  const { call } = await startApp(t);
  const data = {
    version: 1,
    collections: [{ id: '1', name: 'f', type: 'folder', children: [] }],
    environments: [],
    activeEnvironmentId: null,
    history: [],
    settings: { insecure: false, timeoutMs: 30000 },
  };
  assert.equal((await call('PUT', '/api/data', data)).status, 200);
  const got = await (await call('GET', '/api/data')).json();
  assert.deepEqual(got, { ok: true, data, warning: null });
  const bad = await call('PUT', '/api/data', [1, 2]);
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, 'INVALID_DATA');
});

test('server: /api/send 는 요청 실패도 200 과 ok:false 로 돌려준다', async (t) => {
  const { call } = await startApp(t);
  const ok = await (await call('POST', '/api/send', { method: 'GET', url: `${echo.base}/x` })).json();
  assert.equal(ok.ok, true);
  assert.equal(ok.status, 200);
  const res = await call('POST', '/api/send', { url: '{{nope}}/x' });
  assert.equal(res.status, 200);
  const failed = await res.json();
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'UNDEFINED_VARIABLE');
});

test('server: 잘못된 JSON·50MB 초과 본문 뒤에도 계속 응답한다', async (t) => {
  const { call } = await startApp(t);
  const badJson = await call('POST', '/api/send', '{ 깨짐');
  assert.equal(badJson.status, 400);
  assert.equal((await badJson.json()).error.code, 'INVALID_JSON');
  const tooLarge = await call('PUT', '/api/data', 'x'.repeat(51 * 1024 * 1024));
  assert.equal(tooLarge.status, 413);
  assert.equal((await call('GET', '/api/data')).status, 200);
});

test('server: Postman 가져오기', async (t) => {
  const { call } = await startApp(t);
  const ok = await (await call('POST', '/api/import/postman', POSTMAN_SAMPLE)).json();
  assert.equal(ok.ok, true);
  assert.equal(ok.collection.name, '주문 API');
  assert.equal(ok.skipped, 3);
  const bad = await call('POST', '/api/import/postman', { info: {} });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, 'UNSUPPORTED_POSTMAN');
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test.js`
Expected: 새 6개 FAIL — `createServer is not a function`

- [ ] **Step 3: 구현** — `server.js` 의 `module.exports` 위에 추가

```js
const MAX_REQUEST_BYTES = 50 * 1024 * 1024; // 첨부 파일이 base64 로 실려 오므로 넉넉히 잡는다

// 본문을 끝까지 읽은 뒤 판정한다. 중간에 끊으면 브라우저가 413 대신 연결 오류를 받는다.
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_REQUEST_BYTES) chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > MAX_REQUEST_BYTES) return reject(new RequestError('TOO_LARGE', `요청 본문이 ${MAX_REQUEST_BYTES / 1024 / 1024}MB 를 넘습니다`, '첨부 파일 크기를 줄이세요'));
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new RequestError('INVALID_JSON', '요청 본문이 올바른 JSON 이 아닙니다'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

const failure = (code, message) => ({ ok: false, error: { code, message, hint: '' } });

function safeEqual(given, expected) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// /api/send 는 아무 주소로나 요청을 보내는 프록시이므로, 이 PC 의 다른 웹페이지가 쓰지 못하게
// Host 검사(DNS 리바인딩 방지)와 페이지에만 심은 토큰 검사를 모두 통과해야 한다.
function createServer({ dataFile, token, indexFile = path.join(__dirname, 'index.html') }) {
  return http.createServer(async (req, res) => {
    try {
      if (req.headers.host !== `127.0.0.1:${req.socket.localPort}`) return sendJson(res, 403, failure('FORBIDDEN', '허용되지 않은 Host 입니다'));
      if (req.method === 'GET' && req.url === '/') {
        const html = fs.readFileSync(indexFile, 'utf8').replaceAll('__TOKEN__', token);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html);
      }
      if (!safeEqual(req.headers['x-token'], token)) return sendJson(res, 403, failure('FORBIDDEN', '토큰이 올바르지 않습니다'));

      if (req.method === 'POST' && req.url === '/api/send') {
        const spec = await readJson(req);
        try {
          return sendJson(res, 200, await sendRequest(spec));
        } catch (err) {
          return sendJson(res, 200, { ok: false, error: toError(err) });
        }
      }
      if (req.method === 'GET' && req.url === '/api/data') return sendJson(res, 200, { ok: true, ...loadData(dataFile) });
      if (req.method === 'PUT' && req.url === '/api/data') {
        saveData(dataFile, await readJson(req));
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && req.url === '/api/import/postman') return sendJson(res, 200, { ok: true, ...convertPostman(await readJson(req)) });
      return sendJson(res, 404, failure('NOT_FOUND', '없는 경로입니다'));
    } catch (err) {
      const status = err.code === 'TOO_LARGE' ? 413 : err instanceof RequestError ? 400 : 500;
      return sendJson(res, status, { ok: false, error: toError(err) });
    }
  });
}

// Edge → Chrome 순으로 주소창 없는 앱 창을 띄운다. 둘 다 없으면 기본 브라우저로 연다.
function openAppWindow(url) {
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const browsers = [['Microsoft', 'Edge', 'Application', 'msedge.exe'], ['Google', 'Chrome', 'Application', 'chrome.exe']];
  for (const parts of browsers) {
    for (const root of roots) {
      const exe = path.join(root, ...parts);
      if (fs.existsSync(exe)) {
        spawn(exe, [`--app=${url}`], { detached: true, stdio: 'ignore' }).unref();
        return;
      }
    }
  }
  // start 의 첫 인자는 창 제목이므로 빈 문자열을 둔다.
  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
}

if (require.main === module) {
  const token = crypto.randomBytes(24).toString('hex');
  const server = createServer({ dataFile: path.join(__dirname, 'data.json'), token });
  server.listen(0, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}/`;
    console.log(`API 클라이언트 실행 중: ${url}`);
    console.log('이 창을 닫으면 종료됩니다.');
    openAppWindow(url);
  });
}
```

`module.exports` 줄 교체:

```js
module.exports = { RequestError, substitute, buildRequest, sendRequest, toError, loadData, saveData, convertPostman, createServer };
```

`실행.bat` 생성 (ASCII 만 사용, CRLF):

```bat
@echo off
cd /d "%~dp0"
node server.js || pause
```

`.gitattributes` 생성:

```
*.bat text eol=crlf
```

- [ ] **Step 4: 통과 확인**

Run: `node --test test.js`
Expected: 26개 모두 PASS

- [ ] **Step 5: 실행 확인**

Run: `node server.js` (index.html 이 아직 없으므로 창에는 오류 응답이 보이는 것이 정상)
Expected: 콘솔에 `API 클라이언트 실행 중: http://127.0.0.1:<포트>/` 가 찍히고 Edge 앱 창이 열린다. Ctrl+C 로 종료.

- [ ] **Step 6: 커밋**

```bash
git add server.js test.js 실행.bat .gitattributes
git commit -m "로컬 서버: 토큰·Host 검사, API 라우트, Edge 앱 창 실행"
```

---

### Task 6: 화면 (index.html)

**Files:**
- Create: `index.html`

**Interfaces:**
- Consumes: `GET /` 토큰 치환(`'__TOKEN__'`), `POST /api/send`, `GET|PUT /api/data` (`{ ok, data, warning }`), `POST /api/import/postman` (`{ ok, collection, skipped }`). 모든 API 는 `X-Token` 헤더 필요.
- 요청 객체 형식은 Task 4 의 `request` 와 같다. 화면은 URL 입력칸에 `url + '?' + 활성 params` 를 보여주고, 서버에는 `url`(쿼리 제외)과 `params` 를 따로 보낸다.

- [ ] **Step 1: `index.html` 작성**

```html
<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>API 클라이언트</title>
<style>
  :root {
    --bg: #1e1f22; --panel: #2b2d31; --line: #3a3c42; --text: #e6e6e6; --muted: #9a9ca3;
    --accent: #e8743b; --ok: #3fb950; --warn: #d29922; --err: #f85149;
    font: 13px/1.4 "Segoe UI", "Malgun Gothic", sans-serif;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); }
  #app { display: grid; grid-template-columns: 260px 1fr; height: 100vh; }
  aside { background: var(--panel); border-right: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; }
  main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  button, select, input, textarea, label.button {
    font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--line); border-radius: 4px; padding: 4px 8px;
  }
  button, label.button { cursor: pointer; background: var(--panel); }
  button:disabled { opacity: .5; cursor: default; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .tabs { display: flex; gap: 2px; align-items: center; border-bottom: 1px solid var(--line); padding: 0 8px; }
  .tabs button { border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: none; padding: 8px 10px; color: var(--muted); }
  .tabs button.active { color: var(--text); border-bottom-color: var(--accent); }
  header, .urlbar { display: flex; gap: 6px; align-items: center; padding: 8px; border-bottom: 1px solid var(--line); }
  .spacer { flex: 1; }
  .urlbar input { flex: 1; font-family: Consolas, monospace; }
  .pane { padding: 8px; overflow: auto; }
  aside .pane { flex: 1; }
  #request-pane { max-height: 40vh; }
  .row { display: flex; gap: 6px; align-items: center; margin-bottom: 8px; }
  .row.end { justify-content: flex-end; margin: 12px 0 0; }
  table.kv { width: 100%; border-collapse: collapse; }
  table.kv td { padding: 2px; vertical-align: middle; }
  table.kv td:first-child { width: 24px; }
  table.kv input:not([type=checkbox]) { width: 100%; }
  #res-headers td { font-family: Consolas, monospace; padding: 2px 8px; }
  textarea { width: 100%; min-height: 160px; font-family: Consolas, monospace; resize: vertical; }
  #auth-bearer, #auth-basic { margin-top: 8px; display: flex; gap: 6px; }
  #auth-bearer input { flex: 1; }
  #response { flex: 1; display: flex; flex-direction: column; min-height: 0; border-top: 1px solid var(--line); }
  #response > .pane { flex: 1; min-height: 0; }
  #res-meta { color: var(--muted); padding: 8px 0; }
  .s2 { color: var(--ok); } .s3 { color: var(--warn); } .s4, .s5, .error { color: var(--err); }
  pre { margin: 0; font-family: Consolas, monospace; white-space: pre-wrap; word-break: break-all; }
  .tree, .tree ul { list-style: none; margin: 0; padding-left: 10px; }
  .tree { padding-left: 0; }
  .tree span.node { display: block; padding: 3px 6px; border-radius: 4px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tree span.node:hover, #history li:hover { background: var(--line); }
  .tree span.node.selected { background: var(--accent); color: #fff; }
  .method { font-size: 11px; font-weight: 600; color: var(--muted); margin-right: 6px; }
  #history { list-style: none; margin: 0; padding: 0; }
  #history li { padding: 4px 6px; border-radius: 4px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #history small { display: block; color: var(--muted); }
  #menu { position: fixed; z-index: 10; display: flex; flex-direction: column; background: var(--panel); border: 1px solid var(--line); border-radius: 4px; }
  #menu button { border: 0; border-radius: 0; text-align: left; }
  dialog { background: var(--panel); color: var(--text); border: 1px solid var(--line); border-radius: 6px; min-width: 460px; }
  dialog::backdrop { background: #0008; }
  dialog h3 { margin-top: 0; }
  dialog label { display: block; margin-bottom: 8px; }
  #toast { position: fixed; right: 16px; bottom: 16px; max-width: 420px; padding: 10px 14px; border-radius: 6px; background: var(--panel); border: 1px solid var(--line); }
  #toast.error { border-color: var(--err); } #toast.warn { border-color: var(--warn); }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<div id="app">
  <aside>
    <div class="tabs" id="side-tabs">
      <button type="button" class="active" data-tab="side-collections">컬렉션</button>
      <button type="button" data-tab="side-history">히스토리</button>
    </div>
    <div id="side-collections" class="pane">
      <div class="row"><button type="button" id="new-request">+ 새 요청</button><button type="button" id="new-folder">+ 새 폴더</button></div>
      <div id="tree"></div>
    </div>
    <div id="side-history" class="pane" hidden><ul id="history"></ul></div>
  </aside>

  <main>
    <header>
      <label>환경 <select id="env"></select></label>
      <button type="button" id="edit-env">환경 편집</button>
      <button type="button" id="open-settings" title="설정">⚙</button>
      <span class="spacer"></span>
      <label class="button">Postman 가져오기<input type="file" id="import" accept=".json,application/json" hidden></label>
    </header>

    <div class="urlbar">
      <select id="method"></select>
      <input id="url" placeholder="https://example.com/api 또는 {{baseUrl}}/path" spellcheck="false">
      <button type="button" id="send" class="primary">보내기</button>
      <button type="button" id="save">저장</button>
    </div>

    <div class="tabs" id="req-tabs">
      <button type="button" class="active" data-tab="tab-params">Params</button>
      <button type="button" data-tab="tab-headers">Headers</button>
      <button type="button" data-tab="tab-auth">Auth</button>
      <button type="button" data-tab="tab-body">Body</button>
    </div>
    <div id="request-pane" class="pane">
      <div id="tab-params"><table class="kv" id="params"></table></div>
      <div id="tab-headers" hidden><table class="kv" id="headers"></table></div>
      <div id="tab-auth" hidden>
        <select id="auth-type">
          <option value="none">없음</option>
          <option value="bearer">Bearer Token</option>
          <option value="basic">Basic Auth</option>
        </select>
        <div id="auth-bearer"><input id="auth-token" placeholder="토큰 ({{token}} 사용 가능)" spellcheck="false"></div>
        <div id="auth-basic"><input id="auth-user" placeholder="사용자"><input id="auth-pass" type="password" placeholder="비밀번호"></div>
      </div>
      <div id="tab-body" hidden>
        <div class="row">
          <label><input type="radio" name="body-type" value="none"> none</label>
          <label><input type="radio" name="body-type" value="json"> JSON</label>
          <label><input type="radio" name="body-type" value="form"> form-data</label>
          <label><input type="radio" name="body-type" value="urlencoded"> x-www-form-urlencoded</label>
          <label><input type="radio" name="body-type" value="raw"> raw</label>
        </div>
        <textarea id="body-raw" spellcheck="false"></textarea>
        <table class="kv" id="body-fields"></table>
      </div>
    </div>

    <section id="response">
      <div class="tabs" id="res-tabs">
        <span id="res-meta">응답이 여기에 표시됩니다</span>
        <span class="spacer"></span>
        <button type="button" class="active" data-tab="res-body-pane">Body</button>
        <button type="button" data-tab="res-headers-pane">Headers</button>
      </div>
      <div id="res-body-pane" class="pane"><pre id="res-body"></pre></div>
      <div id="res-headers-pane" class="pane" hidden><table id="res-headers"></table></div>
    </section>
  </main>
</div>

<div id="menu" hidden></div>
<div id="toast" hidden></div>

<dialog id="save-dialog">
  <form method="dialog">
    <h3>요청 저장</h3>
    <label>이름 <input id="save-name" required></label>
    <label>폴더 <select id="save-folder"></select></label>
    <div class="row end"><button value="cancel" formnovalidate>취소</button><button value="ok" class="primary">저장</button></div>
  </form>
</dialog>

<dialog id="env-dialog">
  <form method="dialog">
    <h3>환경 편집</h3>
    <div class="row">
      <select id="env-pick"></select>
      <button type="button" id="env-add">추가</button>
      <button type="button" id="env-del">삭제</button>
    </div>
    <label>이름 <input id="env-name"></label>
    <table class="kv" id="env-vars"></table>
    <div class="row end"><button value="ok" class="primary">닫기</button></div>
  </form>
</dialog>

<dialog id="settings-dialog">
  <form method="dialog">
    <h3>설정</h3>
    <label><input type="checkbox" id="set-insecure"> SSL 인증서 검증 무시 (자체 서명 인증서를 쓰는 사내 서버용)</label>
    <label>타임아웃(초) <input type="number" id="set-timeout" min="1" max="600" required></label>
    <div class="row end"><button value="cancel" formnovalidate>취소</button><button value="ok" class="primary">저장</button></div>
  </form>
</dialog>

<script>
'use strict';
const TOKEN = '__TOKEN__';
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const HISTORY_LIMIT = 100;     // 스펙: 히스토리는 최근 100건만 유지
const MAX_TIMEOUT_SECONDS = 600;

const $ = (selector) => document.querySelector(selector);
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}
const newId = () => crypto.randomUUID();
const blankRow = () => ({ key: '', value: '', enabled: true });
const blankRequest = () => ({
  method: 'GET', url: '', params: [], headers: [],
  auth: { type: 'none', token: '', username: '', password: '' },
  body: { type: 'none', raw: '', fields: [] },
});
// 오래된 저장본이나 가져온 요청에 빠진 필드를 기본값으로 채운다.
function normalize(request) {
  const blank = blankRequest();
  return { ...blank, ...request, auth: { ...blank.auth, ...request.auth }, body: { ...blank.body, ...request.body } };
}

let data;                    // GET /api/data 의 data. 바꾼 뒤 save() 로 저장한다
let current = blankRequest(); // 편집 중인 요청
let currentId = null;        // 컬렉션에서 연 요청 노드 id. 새 요청·히스토리에서 연 요청은 null
const collapsed = new Set(); // 접힌 폴더 id. 화면 상태라 저장하지 않는다

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'X-Token': TOKEN, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
  return json;
}

function save() {
  api('PUT', '/api/data', data).catch((err) => toast(`저장 실패: ${err.message}`, 'error'));
}

let toastTimer;
function toast(message, kind = 'info') {
  const box = $('#toast');
  box.textContent = message;
  box.className = kind;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 5000);
}

// 탭 바의 data-tab 버튼과 같은 id 의 패널만 보이게 한다.
function setupTabs(bar) {
  bar.addEventListener('click', (event) => {
    const clicked = event.target.closest('button[data-tab]');
    if (!clicked) return;
    for (const button of bar.querySelectorAll('button[data-tab]')) {
      button.classList.toggle('active', button === clicked);
      $(`#${button.dataset.tab}`).hidden = button !== clicked;
    }
  });
}

// key/value 표. rows 배열을 직접 고치며, 마지막 줄은 항상 입력용 빈 줄이다.
function renderKv(table, rows, onChange, withFiles = false) {
  const last = rows.at(-1);
  if (!last || last.key || last.value || last.fileName) rows.push(blankRow());
  table.replaceChildren(...rows.map((row) => kvRow(table, rows, row, onChange, withFiles)));
}

function kvRow(table, rows, row, onChange, withFiles) {
  // 빈 줄에 입력이 생기면 그 아래에 새 빈 줄을 붙인다. 표 전체를 다시 그리지 않아 입력 포커스가 유지된다.
  function edited() {
    if (row === rows.at(-1)) {
      const next = blankRow();
      rows.push(next);
      table.append(kvRow(table, rows, next, onChange, withFiles));
    }
    onChange();
  }

  const check = el('input', { type: 'checkbox', checked: row.enabled !== false });
  check.onchange = () => { row.enabled = check.checked; onChange(); };
  const key = el('input', { value: row.key, placeholder: 'key', spellcheck: false });
  key.oninput = () => { row.key = key.value; edited(); };

  const valueCell = el('td');
  function renderValue() {
    if (row.type === 'file') {
      const picker = el('input', { type: 'file' });
      picker.onchange = () => readFile(picker.files[0], row)
        .then(() => { renderValue(); edited(); })
        .catch((err) => toast(err.message, 'error'));
      valueCell.replaceChildren(picker, el('span', { textContent: row.fileName ? ` ${row.fileName}` : '' }));
    } else {
      const value = el('input', { value: row.value, placeholder: 'value', spellcheck: false });
      value.oninput = () => { row.value = value.value; edited(); };
      valueCell.replaceChildren(value);
    }
  }
  renderValue();

  const remove = el('button', { type: 'button', textContent: '×', title: '삭제' });
  remove.onclick = () => {
    rows.splice(rows.indexOf(row), 1);
    renderKv(table, rows, onChange, withFiles);
    onChange();
  };

  const cells = [el('td', {}, check), el('td', {}, key)];
  if (withFiles) {
    const type = el('select', {}, el('option', { value: 'text', textContent: 'Text' }), el('option', { value: 'file', textContent: 'File' }));
    type.value = row.type || 'text';
    type.onchange = () => { row.type = type.value; renderValue(); edited(); };
    cells.push(el('td', {}, type));
  }
  cells.push(valueCell, el('td', {}, remove));
  return el('tr', {}, ...cells);
}

function readFile(file, row) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve();
    const reader = new FileReader();
    reader.onload = () => {
      row.fileName = file.name;
      row.fileBase64 = reader.result.split(',')[1] || '';
      resolve();
    };
    reader.onerror = () => reject(new Error(`파일을 읽을 수 없습니다: ${file.name}`));
    reader.readAsDataURL(file);
  });
}

// URL 입력칸 = url + '?' + 활성 params. 서버에는 url 과 params 를 따로 보내고, 인코딩은 서버가 한다.
function composeUrl() {
  const query = current.params.filter((p) => p.enabled !== false && p.key).map((p) => `${p.key}=${p.value}`).join('&');
  return query ? `${current.url}?${query}` : current.url;
}

const decode = (text) => { try { return decodeURIComponent(text); } catch { return text; } };

// URL 입력칸을 고치면 쿼리 부분으로 활성 params 를 다시 만든다. 비활성 params 는 남겨 둔다.
function parseUrlInput(text) {
  const q = text.indexOf('?');
  current.url = q < 0 ? text : text.slice(0, q);
  const parsed = (q < 0 ? '' : text.slice(q + 1)).split('&').filter(Boolean).map((pair) => {
    const i = pair.indexOf('=');
    return { key: decode(i < 0 ? pair : pair.slice(0, i)), value: i < 0 ? '' : decode(pair.slice(i + 1)), enabled: true };
  });
  current.params = [...parsed, ...current.params.filter((p) => p.enabled === false)];
}

const onParamsChange = () => { $('#url').value = composeUrl(); };

function renderEditor() {
  $('#method').value = current.method;
  $('#url').value = composeUrl();
  renderKv($('#params'), current.params, onParamsChange);
  renderKv($('#headers'), current.headers, () => {});
  $('#auth-type').value = current.auth.type;
  $('#auth-token').value = current.auth.token;
  $('#auth-user').value = current.auth.username;
  $('#auth-pass').value = current.auth.password;
  showAuth();
  for (const radio of document.querySelectorAll('input[name=body-type]')) radio.checked = radio.value === current.body.type;
  $('#body-raw').value = current.body.raw;
  showBody();
  renderTree();
}

function showAuth() {
  $('#auth-bearer').hidden = current.auth.type !== 'bearer';
  $('#auth-basic').hidden = current.auth.type !== 'basic';
}

function showBody() {
  const type = current.body.type;
  $('#body-raw').hidden = type !== 'json' && type !== 'raw';
  $('#body-fields').hidden = type !== 'form' && type !== 'urlencoded';
  if (!$('#body-fields').hidden) renderKv($('#body-fields'), current.body.fields, () => {}, type === 'form');
}

function openRequest(request, id) {
  current = normalize(structuredClone(request));
  currentId = id;
  renderEditor();
}

function activeVariables() {
  const env = data.environments.find((e) => e.id === data.activeEnvironmentId);
  return Object.fromEntries((env?.variables || []).filter((v) => v.enabled !== false && v.key).map((v) => [v.key, v.value]));
}

// 히스토리에는 첨부 파일 내용을 남기지 않는다. data.json 이 파일 크기만큼 불어나는 것을 막는다.
function withoutFiles(request) {
  const copy = structuredClone(request);
  for (const field of copy.body.fields) delete field.fileBase64;
  return copy;
}

async function sendCurrent() {
  const button = $('#send');
  button.disabled = true;
  $('#res-meta').textContent = '보내는 중…';
  $('#res-body').textContent = '';
  $('#res-headers').replaceChildren();
  let result;
  try {
    result = await api('POST', '/api/send', { ...current, variables: activeVariables(), settings: data.settings });
  } catch (err) {
    result = { ok: false, error: { code: '', message: err.message, hint: '' } };
  }
  button.disabled = false;
  showResponse(result);
  data.history.unshift({
    at: new Date().toISOString(),
    request: withoutFiles(current),
    status: result.ok ? result.status : null,
    timeMs: result.ok ? result.timeMs : null,
  });
  data.history.splice(HISTORY_LIMIT);
  renderHistory();
  save();
}

const pretty = (text) => { try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; } };

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function showResponse(result) {
  const meta = $('#res-meta');
  if (!result.ok) {
    const { code, message, hint } = result.error;
    meta.replaceChildren(el('span', { className: 'error', textContent: code ? `${code} · ${message}` : message }));
    $('#res-body').textContent = hint || '';
    $('#res-headers').replaceChildren();
    return;
  }
  meta.replaceChildren(
    el('span', { className: `s${String(result.status)[0]}`, textContent: `${result.status} ${result.statusText}` }),
    ` · ${result.timeMs} ms · ${formatSize(result.size)}`,
    result.truncated ? ' · 앞 10MB 만 표시' : '',
  );
  $('#res-body').textContent = pretty(result.body);
  $('#res-headers').replaceChildren(...result.headers.map(([k, v]) => el('tr', {}, el('td', { textContent: k }), el('td', { textContent: v }))));
}

function findNode(nodes, id) {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.type === 'folder') {
      const found = findNode(node.children, id);
      if (found) return found;
    }
  }
  return null;
}

function removeNode(nodes, id) {
  const i = nodes.findIndex((n) => n.id === id);
  if (i >= 0) {
    nodes.splice(i, 1);
    return true;
  }
  return nodes.some((n) => n.type === 'folder' && removeNode(n.children, id));
}

const folder = (name) => ({ id: newId(), name, type: 'folder', children: [] });

function renderTree() {
  $('#tree').replaceChildren(treeList(data.collections));
}

function treeList(nodes) {
  return el('ul', { className: 'tree' }, ...nodes.map((node) => {
    const label = el('span', { className: 'node', title: node.name });
    if (node.type === 'folder') {
      label.textContent = `${collapsed.has(node.id) ? '▶' : '▼'} ${node.name}`;
      label.onclick = () => {
        if (collapsed.has(node.id)) collapsed.delete(node.id);
        else collapsed.add(node.id);
        renderTree();
      };
    } else {
      label.append(el('span', { className: 'method', textContent: node.request.method }), node.name);
      label.classList.toggle('selected', node.id === currentId);
      label.onclick = () => openRequest(node.request, node.id);
    }
    label.oncontextmenu = (event) => {
      event.preventDefault();
      showMenu(event, node);
    };
    const item = el('li', {}, label);
    if (node.type === 'folder' && !collapsed.has(node.id)) item.append(treeList(node.children));
    return item;
  }));
}

function showMenu(event, node) {
  const actions = [
    ['이름 변경', () => {
      const name = prompt('새 이름', node.name)?.trim();
      if (!name) return;
      node.name = name;
      renderTree();
      save();
    }],
    ['삭제', () => {
      if (!confirm(`"${node.name}" 을(를) 삭제할까요?`)) return;
      removeNode(data.collections, node.id);
      if (currentId && !findNode(data.collections, currentId)) currentId = null;
      renderTree();
      save();
    }],
  ];
  if (node.type === 'folder') {
    actions.unshift(['하위 폴더 추가', () => {
      const name = prompt('폴더 이름')?.trim();
      if (!name) return;
      node.children.push(folder(name));
      renderTree();
      save();
    }]);
  }
  const menu = $('#menu');
  menu.replaceChildren(...actions.map(([text, run]) => el('button', { type: 'button', textContent: text, onclick: () => { menu.hidden = true; run(); } })));
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;
  menu.hidden = false;
}

function folderOptions(nodes, prefix) {
  const options = [];
  for (const node of nodes) {
    if (node.type !== 'folder') continue;
    options.push(el('option', { value: node.id, textContent: prefix + node.name }), ...folderOptions(node.children, `${prefix}${node.name} / `));
  }
  return options;
}

function saveCurrent() {
  const node = currentId && findNode(data.collections, currentId);
  if (node) {
    node.request = structuredClone(current);
    renderTree();
    save();
    toast('저장했습니다');
    return;
  }
  $('#save-folder').replaceChildren(el('option', { value: '', textContent: '(최상위)' }), ...folderOptions(data.collections, ''));
  $('#save-name').value = current.url || '새 요청';
  $('#save-dialog').returnValue = '';
  $('#save-dialog').showModal();
}

function renderHistory() {
  $('#history').replaceChildren(...data.history.map((entry) => {
    const item = el('li', { title: entry.request.url },
      el('span', { className: 'method', textContent: entry.request.method }),
      entry.request.url,
      el('small', { textContent: `${entry.status ?? '실패'} · ${new Date(entry.at).toLocaleString()}` }));
    item.onclick = () => openRequest(entry.request, null);
    return item;
  }));
}

function renderEnvSelect() {
  $('#env').replaceChildren(el('option', { value: '', textContent: '환경 없음' }), ...data.environments.map((e) => el('option', { value: e.id, textContent: e.name })));
  $('#env').value = data.activeEnvironmentId || '';
}

let editingEnv = null;

function renderEnvDialog() {
  $('#env-pick').replaceChildren(...data.environments.map((e) => el('option', { value: e.id, textContent: e.name })));
  $('#env-pick').value = editingEnv?.id || '';
  $('#env-name').value = editingEnv?.name || '';
  $('#env-name').disabled = !editingEnv;
  $('#env-del').disabled = !editingEnv;
  if (editingEnv) renderKv($('#env-vars'), editingEnv.variables, () => {});
  else $('#env-vars').replaceChildren();
}

function bindEvents() {
  setupTabs($('#side-tabs'));
  setupTabs($('#req-tabs'));
  setupTabs($('#res-tabs'));
  document.addEventListener('click', () => { $('#menu').hidden = true; });

  $('#method').onchange = (e) => { current.method = e.target.value; };
  $('#url').oninput = (e) => {
    parseUrlInput(e.target.value);
    renderKv($('#params'), current.params, onParamsChange);
  };
  $('#url').onkeydown = (e) => { if (e.key === 'Enter') sendCurrent(); };
  $('#send').onclick = sendCurrent;
  $('#save').onclick = saveCurrent;

  $('#auth-type').onchange = (e) => { current.auth.type = e.target.value; showAuth(); };
  $('#auth-token').oninput = (e) => { current.auth.token = e.target.value; };
  $('#auth-user').oninput = (e) => { current.auth.username = e.target.value; };
  $('#auth-pass').oninput = (e) => { current.auth.password = e.target.value; };
  for (const radio of document.querySelectorAll('input[name=body-type]')) {
    radio.onchange = () => { current.body.type = radio.value; showBody(); };
  }
  $('#body-raw').oninput = (e) => { current.body.raw = e.target.value; };

  $('#new-request').onclick = () => openRequest(blankRequest(), null);
  $('#new-folder').onclick = () => {
    const name = prompt('폴더 이름')?.trim();
    if (!name) return;
    data.collections.push(folder(name));
    renderTree();
    save();
  };

  $('#save-dialog').onclose = () => {
    if ($('#save-dialog').returnValue !== 'ok') return;
    const name = $('#save-name').value.trim();
    if (!name) return toast('이름을 입력하세요', 'error');
    const node = { id: newId(), name, type: 'request', request: structuredClone(current) };
    const parent = findNode(data.collections, $('#save-folder').value);
    (parent ? parent.children : data.collections).push(node);
    currentId = node.id;
    renderTree();
    save();
  };

  $('#env').onchange = (e) => {
    data.activeEnvironmentId = e.target.value || null;
    save();
  };
  $('#edit-env').onclick = () => {
    editingEnv = data.environments.find((e) => e.id === data.activeEnvironmentId) || data.environments[0] || null;
    renderEnvDialog();
    $('#env-dialog').showModal();
  };
  $('#env-pick').onchange = (e) => {
    editingEnv = data.environments.find((x) => x.id === e.target.value) || null;
    renderEnvDialog();
  };
  $('#env-add').onclick = () => {
    editingEnv = { id: newId(), name: `환경 ${data.environments.length + 1}`, variables: [] };
    data.environments.push(editingEnv);
    renderEnvDialog();
  };
  $('#env-del').onclick = () => {
    if (!confirm(`"${editingEnv.name}" 환경을 삭제할까요?`)) return;
    data.environments.splice(data.environments.indexOf(editingEnv), 1);
    if (data.activeEnvironmentId === editingEnv.id) data.activeEnvironmentId = null;
    editingEnv = data.environments[0] || null;
    renderEnvDialog();
  };
  $('#env-name').oninput = (e) => { editingEnv.name = e.target.value; };
  $('#env-dialog').onclose = () => {
    renderEnvSelect();
    save();
  };

  $('#open-settings').onclick = () => {
    $('#set-insecure').checked = data.settings.insecure;
    $('#set-timeout').value = Math.round(data.settings.timeoutMs / 1000);
    $('#settings-dialog').returnValue = '';
    $('#settings-dialog').showModal();
  };
  $('#settings-dialog').onclose = () => {
    if ($('#settings-dialog').returnValue !== 'ok') return;
    const seconds = Number($('#set-timeout').value);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_TIMEOUT_SECONDS) {
      return toast(`타임아웃은 1~${MAX_TIMEOUT_SECONDS}초 사이 정수여야 합니다`, 'error');
    }
    data.settings = { insecure: $('#set-insecure').checked, timeoutMs: seconds * 1000 };
    save();
  };

  $('#import').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const { collection, skipped } = await api('POST', '/api/import/postman', JSON.parse(await file.text()));
      data.collections.push(collection);
      renderTree();
      save();
      toast(`"${collection.name}" 을(를) 가져왔습니다${skipped ? ` (지원하지 않는 항목 ${skipped}개 건너뜀)` : ''}`);
    } catch (err) {
      toast(`가져오기 실패: ${err.message}`, 'error');
    }
  };
}

async function init() {
  $('#method').replaceChildren(...METHODS.map((m) => el('option', { value: m, textContent: m })));
  bindEvents();
  try {
    const res = await api('GET', '/api/data');
    data = res.data;
    if (res.warning) toast(res.warning, 'warn');
  } catch (err) {
    toast(`데이터를 불러오지 못했습니다: ${err.message}`, 'error');
    return;
  }
  renderEnvSelect();
  renderHistory();
  renderEditor();
}

init();
</script>
</body>
</html>
```

- [ ] **Step 2: 자동 테스트가 그대로 통과하는지 확인**

Run: `node --test test.js`
Expected: 26개 모두 PASS

- [ ] **Step 3: 화면 수동 확인** — `node server.js` 로 띄우고 아래를 순서대로 확인한다. 실패한 항목이 있으면 고치고 다시 확인한다.

1. 주소창 없는 Edge 창이 열리고, 콘솔 오류가 없다 (F12).
2. `GET https://httpbin.org/get?a=1` 보내기 → 200, 정렬된 JSON, 시간·크기 표시. Params 탭에 `a=1` 이 보인다. (인터넷이 막혀 있으면 사내 API 아무거나)
3. Params 탭에서 값을 고치면 URL 칸이 바뀌고, URL 칸을 고치면 Params 표가 바뀐다. 체크를 끈 param 은 URL 에서 빠진다.
4. 환경 편집 → 환경 추가, `baseUrl` 변수 입력 → 닫기 → 상단에서 선택 → `{{baseUrl}}/get` 이 보내진다. 정의 안 된 `{{x}}` 를 쓰면 빨간 `UNDEFINED_VARIABLE · 정의되지 않은 변수: x`.
5. Auth: Bearer 로 보내면 httpbin 응답의 `Authorization` 이 `Bearer ...`.
6. Body: JSON / form-data(텍스트+파일) / urlencoded 를 `https://httpbin.org/post` 로 보내 응답에 반영되는지 확인.
7. 저장 → 이름·폴더 지정 → 트리에 나타남. 새 폴더, 우클릭 이름 변경·삭제·하위 폴더 추가.
8. 히스토리 탭에 기록이 쌓이고 클릭하면 다시 열린다.
9. Postman v2.1 컬렉션 파일 가져오기 → 트리에 폴더로 추가, 건너뛴 개수 안내.
10. 설정 → SSL 검증 무시 켜고 `https://self-signed.badssl.com/` → 200. 끄면 SSL 오류와 "SSL 검증 무시를 켜보세요" 안내.
11. 없는 포트(`http://127.0.0.1:1`)로 보내기 → `ECONNREFUSED · 연결이 거부되었습니다`.
12. 콘솔 창을 닫고 `node server.js` 로 다시 켜면 컬렉션·환경·히스토리·설정이 그대로다.
13. `data.json` 을 메모장으로 깨뜨린 뒤 다시 켜면 경고 토스트가 뜨고 `data.json.broken-*` 가 남는다.
14. `실행.bat` 더블클릭으로도 켜진다.

- [ ] **Step 4: 커밋**

```bash
git add index.html
git commit -m "화면: 요청 편집, 응답 보기, 컬렉션·히스토리·환경·설정·가져오기"
```

- [ ] **Step 5: 푸시와 백업**

```bash
git push
```

결과물(`server.js`, `test.js`, `index.html`, `실행.bat`, `.gitattributes`)을 `C:\pjt-dxplm\backup\vibe-dev-tools\<yyyyMMdd-HHmmss>-after\` 에 같은 상대경로로 복사한다. 복사가 권한 문제로 막히면 사용자에게 알린다.
