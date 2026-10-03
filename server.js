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

module.exports = { RequestError, substitute, buildRequest, sendRequest, toError, loadData, saveData };
