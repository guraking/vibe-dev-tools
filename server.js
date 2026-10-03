'use strict';
// 포터블 API 클라이언트 서버. Node 18 이상, npm 패키지 없이 내장 모듈만 사용한다.
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
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
  // Node 는 헤더에 Latin-1 밖의 문자(한글 등)를 넣으면 영문 오류를 던지므로, 보내기 전에 어느 헤더인지 알려준다.
  for (const h of enabledRows(spec.headers)) {
    const key = sub(h.key);
    const value = sub(h.value);
    try {
      http.validateHeaderName(key);
      http.validateHeaderValue(key, value);
    } catch {
      throw new RequestError('INVALID_HEADER', `헤더 "${key}" 에 보낼 수 없는 문자가 있습니다`, '한글 등은 URL 인코딩해서 넣으세요');
    }
    headers[key] = value;
  }

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

const DECOMPRESSORS = { gzip: zlib.gunzipSync, 'x-gzip': zlib.gunzipSync, deflate: zlib.inflateSync, br: zlib.brotliDecompressSync };

// 압축을 풀고 Content-Type 의 charset 으로 해석한다. 잘린 압축 본문이나 풀 수 없는 본문은 받은 바이트 그대로 해석한다.
// 압축을 푼 결과도 10MB 까지만 돌려준다.
// ponytail: 압축 해제 크기에 상한이 없다. 테스트 대상 서버가 압축 폭탄을 보내면 메모리를 많이 쓴다.
function decodeBody(raw, headers, truncated) {
  let bytes = raw;
  const decompress = DECOMPRESSORS[String(headers['content-encoding'] || '').trim().toLowerCase()];
  if (decompress && !truncated) {
    try {
      bytes = decompress(raw);
    } catch {
      bytes = raw;
    }
  }
  const charset = /charset=["']?([\w-]+)/i.exec(headers['content-type'] || '')?.[1] || 'utf-8';
  let decoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  const over = bytes.length > MAX_RESPONSE_BYTES;
  return { text: decoder.decode(over ? bytes.subarray(0, MAX_RESPONSE_BYTES) : bytes), truncated: truncated || over };
}

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
        const decoded = decodeBody(Buffer.concat(chunks), res.headers, size > MAX_RESPONSE_BYTES);
        resolve({
          ok: true,
          status: res.statusCode,
          statusText: res.statusMessage,
          timeMs: Math.round(performance.now() - started),
          size,
          headers: pairs,
          body: decoded.text,
          truncated: decoded.truncated,
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

// Postman 은 쿼리를 입력한 그대로(이미 퍼센트 인코딩된 상태로) 저장한다. 전송 때 buildRequest 가 다시 인코딩하므로 여기서 풀어 둔다.
const decodeQuery = (text) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

const decodeRows = (rows) => rows.map((row) => ({ ...row, key: decodeQuery(row.key), value: decodeQuery(row.value) }));

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
  // 컬렉션 변수는 가져오지 않는다. 환경 편집에서 같은 이름으로 직접 만들어야 한다.
  const state = { skipped: (json.variable || []).length };
  const collection = convertPostmanFolder(json.info.name || 'Postman', json, state, null);
  return { collection, skipped: state.skipped };
}

// 인증이 없는 요청은 가장 가까운 상위 폴더(또는 컬렉션)의 인증을 쓴다. Postman 의 "Inherit auth from parent" 와 같다.
function convertPostmanFolder(name, folder, state, inheritedAuth) {
  state.skipped += (folder.event || []).length;
  const auth = folder.auth ?? inheritedAuth;
  const children = (folder.item || []).map((child) => (Array.isArray(child.item)
    ? convertPostmanFolder(child.name || '폴더', child, state, auth)
    : convertPostmanItem(child, state, auth)));
  return { id: crypto.randomUUID(), name, type: 'folder', children };
}

function convertPostmanItem(item, state, inheritedAuth) {
  state.skipped += (item.event || []).length;
  return { id: crypto.randomUUID(), name: item.name || '요청', type: 'request', request: convertPostmanRequest(item.request, state, inheritedAuth) };
}

function convertPostmanRequest(source, state, inheritedAuth) {
  const request = blankRequest();
  // v2.0 은 request 자리에 URL 문자열만 둘 수 있다.
  const r = typeof source === 'string' ? { url: source } : source;
  if (!r) return request;

  request.method = String(r.method || 'GET').toUpperCase();
  const raw = typeof r.url === 'string' ? r.url : r.url?.raw || '';
  const q = raw.indexOf('?');
  request.url = q < 0 ? raw : raw.slice(0, q);
  request.params = decodeRows(r.url && typeof r.url === 'object' ? postmanRows(r.url.query) : parseQuery(q < 0 ? '' : raw.slice(q + 1)));
  request.headers = postmanRows(r.header);

  const auth = r.auth ?? inheritedAuth;
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

function sendFont(res, file) {
  let data;
  try {
    data = fs.readFileSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') return sendJson(res, 404, failure('NOT_FOUND', '없는 폰트입니다'));
    throw err;
  }
  res.writeHead(200, { 'Content-Type': 'font/woff2', 'Cache-Control': 'max-age=86400' });
  res.end(data);
}

const failure = (code, message) => ({ ok: false, error: { code, message, hint: '' } });

function safeEqual(given, expected) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// /api/send 는 아무 주소로나 요청을 보내는 프록시이므로, 이 PC 의 다른 웹페이지가 쓰지 못하게
// Host 검사(DNS 리바인딩 방지)와 페이지에만 심은 토큰 검사를 모두 통과해야 한다.
function createServer({ dataFile, token, indexFile = path.join(__dirname, 'index.html'), fontDir = path.join(__dirname, 'fonts') }) {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.headers.host !== `127.0.0.1:${req.socket.localPort}`) return sendJson(res, 403, failure('FORBIDDEN', '허용되지 않은 Host 입니다'));
      if (req.method === 'GET' && req.url === '/') {
        const html = fs.readFileSync(indexFile, 'utf8').replaceAll('__TOKEN__', token);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html);
      }
      // 폰트는 CSS 가 토큰 헤더 없이 불러오므로 토큰 검사 전에 둔다. 영문·숫자·하이픈 이름의 .woff2 만 허용해 다른 파일은 읽을 수 없다.
      const font = /^\/fonts\/([A-Za-z0-9-]+\.woff2)$/.exec(req.url);
      if (req.method === 'GET' && font) return sendFont(res, path.join(fontDir, font[1]));
      if (!safeEqual(req.headers['x-token'], token)) return sendJson(res, 403, failure('FORBIDDEN', '토큰이 올바르지 않습니다'));

      if (req.method === 'POST' && req.url === '/api/send') {
        const spec = await readJson(req);
        try {
          return sendJson(res, 200, await sendRequest(spec));
        } catch (err) {
          return sendJson(res, 200, { ok: false, error: toError(err) });
        }
      }
      if (req.method === 'POST' && req.url === '/api/ping') {
        server.lastPing = Date.now();
        return sendJson(res, 200, { ok: true });
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
  // 앱 창이 /api/ping 을 마지막으로 보낸 시각. 창이 한 번도 열리지 않은 경우를 위해 시작 시각으로 초기화한다.
  server.lastPing = Date.now();
  return server;
}

// 첫 실행 때의 앱 창 크기(너비,높이). 사용자가 직접 맞춘 크기 기준이다.
const APP_WINDOW_SIZE = '1250,910';
// 이미 실행 중인 Edge 에 창을 맡기면 --window-size 가 무시되므로, 이 도구 전용 프로필로 별도 프로세스를 띄운다.
// 프로필은 수십 MB 라 USB 가 아닌 이 PC 에 둔다. 사용자가 바꾼 창 크기도 이 프로필이 기억한다.
const APP_PROFILE_DIR = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'vibe-dev-tools', 'browser-profile');

// Edge → Chrome 순으로 주소창 없는 앱 창을 띄운다. 둘 다 없으면 기본 브라우저로 연다.
function openAppWindow(url) {
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const browsers = [['Microsoft', 'Edge', 'Application', 'msedge.exe'], ['Google', 'Chrome', 'Application', 'chrome.exe']];
  for (const parts of browsers) {
    for (const root of roots) {
      const exe = path.join(root, ...parts);
      if (fs.existsSync(exe)) {
        spawn(exe, [`--app=${url}`, `--window-size=${APP_WINDOW_SIZE}`, `--user-data-dir=${APP_PROFILE_DIR}`, '--no-first-run'], { detached: true, stdio: 'ignore' }).unref();
        return;
      }
    }
  }
  // start 의 첫 인자는 창 제목이므로 빈 문자열을 둔다.
  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
}

// 창을 최소화하고 5분이 지나면 Edge 가 타이머를 1분에 한 번으로 줄이므로, 종료 기준은 1분보다 넉넉히 잡는다.
const IDLE_LIMIT_MS = 90 * 1000;
const IDLE_CHECK_MS = 10 * 1000;

if (require.main === module && process.argv.includes('--background')) {
  // 콘솔 없는 자식 프로세스로 다시 띄우고 바로 끝낸다. 화면이 없으므로 자식의 출력과 오류는 server.log 에 남긴다.
  const log = fs.openSync(path.join(__dirname, 'server.log'), 'a');
  spawn(process.execPath, [__filename], { detached: true, windowsHide: true, stdio: ['ignore', log, log] }).unref();
} else if (require.main === module) {
  const token = crypto.randomBytes(24).toString('hex');
  const server = createServer({ dataFile: path.join(__dirname, 'data.json'), token });
  server.listen(0, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}/`;
    console.log(`API 클라이언트 실행 중: ${url}`);
    console.log('이 창을 닫으면 종료됩니다.');
    openAppWindow(url);
  });
  // 앱 창이 신호를 보내지 않은 지 IDLE_LIMIT_MS 가 지나면 창이 닫힌 것으로 보고 종료한다.
  setInterval(() => {
    if (Date.now() - server.lastPing > IDLE_LIMIT_MS) process.exit(0);
  }, IDLE_CHECK_MS);
}

module.exports = { RequestError, substitute, buildRequest, sendRequest, toError, loadData, saveData, convertPostman, createServer };
