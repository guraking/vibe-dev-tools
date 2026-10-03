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

test('sendRequest: 변수 치환이 끝난 최종 URL 과 실제 접속한 IP:포트를 돌려준다', async () => {
  const r = await sendRequest({ url: '{{base}}/get', params: [{ key: 'q', value: '1' }], variables: { base: echo.base } });
  assert.equal(r.url, `${echo.base}/get?q=1`);
  assert.equal(r.remote, `127.0.0.1:${new URL(echo.base).port}`);
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

test('convertPostman: 이미 인코딩된 쿼리 값은 풀어서 가져와 이중 인코딩되지 않는다', async () => {
  const { collection } = convertPostman({
    info: { name: 'q', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [{ name: 'r', request: { method: 'GET', url: { raw: 'http://h/a?d=2024-01-01T00%3A00', query: [{ key: 'd', value: '2024-01-01T00%3A00' }] } } }],
  });
  const { request } = collection.children[0];
  assert.deepEqual(request.params, [{ key: 'd', value: '2024-01-01T00:00', enabled: true }]);
  const built = await buildRequest({ ...request, variables: {} });
  assert.equal(built.url.search, '?d=2024-01-01T00%3A00');
});

test('convertPostman: 폴더·컬렉션 인증을 상속하고, 컬렉션 변수는 건너뛴 항목으로 센다', () => {
  const { collection, skipped } = convertPostman({
    info: { name: 'auth', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: 'root' }] },
    variable: [{ key: 'baseUrl', value: 'http://h' }],
    item: [
      { name: 'inherit', request: { method: 'GET', url: 'http://h/a' } },
      { name: 'f', auth: { type: 'basic', basic: [{ key: 'username', value: 'u' }, { key: 'password', value: 'p' }] }, item: [
        { name: 'folder-auth', request: { method: 'GET', url: 'http://h/b' } },
        { name: 'own', request: { method: 'GET', url: 'http://h/c', auth: { type: 'noauth' } } },
      ] },
    ],
  });
  const [inherit, folder] = collection.children;
  assert.equal(inherit.request.auth.token, 'root');
  assert.equal(folder.children[0].request.auth.type, 'basic');
  assert.equal(folder.children[1].request.auth.type, 'none');
  assert.equal(skipped, 1);
});

test('buildRequest: 헤더에 보낼 수 없는 문자가 있으면 헤더 이름과 함께 거부한다', async () => {
  await assert.rejects(buildRequest({ url: 'http://h', headers: [{ key: 'X-Name', value: '홍길동', enabled: true }] }), { code: 'INVALID_HEADER', message: /X-Name/ });
  await assert.rejects(buildRequest({ url: 'http://h', headers: [{ key: '잘못된 이름', value: 'v', enabled: true }] }), { code: 'INVALID_HEADER' });
});

test('sendRequest: charset 에 맞춰 디코딩하고 gzip 압축을 푼다', async (t) => {
  const zlib = require('node:zlib');
  const server = http.createServer((req, res) => {
    if (req.url === '/euckr') {
      res.setHeader('Content-Type', 'text/plain; charset=euc-kr');
      return res.end(Buffer.from([0xc7, 0xd1, 0xb1, 0xdb])); // '한글'
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Encoding', 'gzip');
    res.end(zlib.gzipSync('{"a":"가"}'));
  });
  const base = await listen(server);
  t.after(() => { server.closeAllConnections(); server.close(); });
  assert.equal((await sendRequest({ url: `${base}/euckr` })).body, '한글');
  assert.equal((await sendRequest({ url: `${base}/gzip` })).body, '{"a":"가"}');
});

test('server: /api/ping 은 마지막 신호 시각을 갱신한다', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-client-'));
  const server = createServer({ dataFile: path.join(dir, 'data.json'), token: 'test-token' });
  const base = await listen(server);
  t.after(() => { server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal(typeof server.lastPing, 'number');
  const before = server.lastPing;
  await new Promise((resolve) => setTimeout(resolve, 20));
  const res = await fetch(`${base}/api/ping`, { method: 'POST', headers: { 'X-Token': 'test-token' } });
  assert.equal(res.status, 200);
  assert.ok(server.lastPing > before);
  assert.equal((await fetch(`${base}/api/ping`, { method: 'POST' })).status, 403);
});

test('server: 폰트는 토큰 없이 받을 수 있고, 다른 파일과 없는 폰트는 거부한다', async (t) => {
  const { base } = await startApp(t);
  const ok = await fetch(`${base}/fonts/JetBrainsMono-Regular.woff2`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'font/woff2');
  assert.equal(Buffer.from(await ok.arrayBuffer()).subarray(0, 4).toString(), 'wOF2');
  assert.equal((await fetch(`${base}/fonts/Nope.woff2`)).status, 404);
  assert.equal((await fetch(`${base}/fonts/..%2Fserver.js`)).status, 403);
  assert.equal((await fetch(`${base}/fonts/server.js`)).status, 403);
  assert.equal(await requestWithHost(`${base}/fonts/JetBrainsMono-Regular.woff2`, 'evil.example'), 403);
});
