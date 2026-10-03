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
