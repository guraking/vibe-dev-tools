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
