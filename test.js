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
