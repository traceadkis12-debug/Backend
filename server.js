'use strict';

const http = require('node:http');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const dns = require('node:dns').promises;
const net = require('node:net');

function loadDotEnv(filePath) {
  let contents;
  try {
    contents = fsSync.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }

  for (const line of contents.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || Object.hasOwn(process.env, match[1])) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")) ||
        (value.startsWith('`') && value.endsWith('`'))) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    process.env[match[1]] = value;
  }
}

loadDotEnv(path.join(__dirname, '.env'));

const CONFIG_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'LocalMailStudio');
const CONFIG_FILE = process.env.APP_CONFIG_FILE || path.join(CONFIG_DIR, 'config.json');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || (process.env.RENDER === 'true' ? '0.0.0.0' : '127.0.0.1');
const ALLOWED_ORIGINS = new Set((process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean));
const MAX_BODY_BYTES = 64 * 1024;

const DEFAULTS = {
  provider: 'resend',
  endpoint: 'https://api.resend.com/emails',
  authHeader: 'Authorization',
  authPrefix: 'Bearer ',
  apiKey: '',
  senderName: '',
  senderEmail: '',
  payloadTemplate: '{\n  "sender": { "name": "{{senderName}}", "email": "{{senderEmail}}" },\n  "to": [{ "email": "{{to}}" }],\n  "subject": "{{subject}}",\n  "htmlContent": "{{html}}",\n  "textContent": "{{text}}"\n}'
};

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function readConfig() {
  try {
    const contents = await fs.readFile(CONFIG_FILE, 'utf8');
    const saved = JSON.parse(contents);
    const config = { ...DEFAULTS, ...saved };
    if (config.provider === 'brevo') {
      config.provider = 'resend';
      config.endpoint = DEFAULTS.endpoint;
      config.authHeader = DEFAULTS.authHeader;
      config.authPrefix = DEFAULTS.authPrefix;
    }
    if (config.provider === 'resend') config.apiKey = process.env.RESEND_API_KEY || '';
    return config;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { ...DEFAULTS, apiKey: process.env.RESEND_API_KEY || '' };
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Saved settings are not valid JSON (${CONFIG_FILE}).`);
    }
    throw error;
  }
}

async function writeConfig(config) {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  const temporaryFile = `${CONFIG_FILE}.${process.pid}.tmp`;
  await fs.writeFile(temporaryFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporaryFile, CONFIG_FILE);
}

function publicSettings(config) {
  return {
    provider: config.provider,
    endpoint: config.endpoint,
    authHeader: config.authHeader,
    authPrefix: config.authPrefix,
    senderName: config.senderName,
    senderEmail: config.senderEmail,
    payloadTemplate: config.payloadTemplate,
    configured: config.provider === 'resend'
      ? Boolean(process.env.RESEND_API_KEY)
      : Boolean(config.apiKey)
  };
}

function validateSettings(input, current) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw httpError(400, 'Settings must be a JSON object.');
  }

  const next = { ...current };
  const providerChanged = input.provider !== undefined && input.provider !== current.provider;
  if (input.provider !== undefined) {
    if (!['resend', 'custom'].includes(input.provider)) {
      throw httpError(400, 'Choose Resend or a custom API provider.');
    }
    next.provider = input.provider;
  }
  if (providerChanged && next.provider === 'custom' && input.apiKey === undefined) {
    next.apiKey = '';
  }

  if (input.apiKey !== undefined && typeof input.apiKey !== 'string') {
    throw httpError(400, 'The API key must be text.');
  }
  if (typeof input.apiKey === 'string' && input.apiKey.trim()) next.apiKey = input.apiKey.trim();
  if (input.clearApiKey === true) next.apiKey = '';

  for (const field of ['senderName', 'senderEmail', 'endpoint', 'authHeader', 'authPrefix', 'payloadTemplate']) {
    if (input[field] !== undefined) {
      if (typeof input[field] !== 'string') throw httpError(400, `${field} must be text.`);
      next[field] = input[field].trim();
    }
  }

  if (next.senderEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.senderEmail)) {
    throw httpError(400, 'Enter a valid sender email address.');
  }
  if (next.provider === 'custom') {
    validateCustomEndpoint(next.endpoint);
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(next.authHeader) ||
        ['content-type', 'content-length', 'host', 'connection', 'transfer-encoding'].includes(next.authHeader.toLowerCase())) {
      throw httpError(400, 'Enter a valid authentication header name.');
    }
    try {
      const template = JSON.parse(next.payloadTemplate);
      const allowed = new Set(['to', 'subject', 'html', 'text', 'senderName', 'senderEmail']);
      const checkTokens = value => {
        if (typeof value === 'string') {
          for (const [, token] of value.matchAll(/\{\{([^}]+)\}\}/g)) {
            if (!allowed.has(token)) throw httpError(400, `Unknown request template token: {{${token}}}.`);
          }
        } else if (Array.isArray(value)) {
          value.forEach(checkTokens);
        } else if (value && typeof value === 'object') {
          Object.values(value).forEach(checkTokens);
        }
      };
      checkTokens(template);
    } catch (error) {
      if (error.status) throw error;
      throw httpError(400, 'The request body template must be valid JSON.');
    }
  } else {
    next.apiKey = '';
    next.endpoint = DEFAULTS.endpoint;
    next.authHeader = DEFAULTS.authHeader;
    next.authPrefix = DEFAULTS.authPrefix;
  }

  return next;
}

function validateCustomEndpoint(endpoint) {
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw httpError(400, 'Enter a valid custom API URL.');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
    throw httpError(400, 'Custom API URLs must use HTTPS and cannot contain credentials or fragments.');
  }
}

function isPublicAddress(address) {
  if (net.isIPv4(address)) {
    const parts = address.split('.').map(Number);
    return !(
      parts[0] === 0 ||
      parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 0) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) ||
      parts[0] >= 224
    );
  }
  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    return (normalized.startsWith('2') || normalized.startsWith('3')) &&
      !normalized.startsWith('2001:db8:') &&
      !normalized.startsWith('2002:') &&
      !normalized.startsWith('2001:0:');
  }
  return false;
}

async function assertPublicEndpoint(endpoint) {
  const { hostname } = new URL(endpoint);
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw httpError(400, 'Custom API endpoints must resolve to a public host.');
  }
  const addresses = net.isIP(hostname)
    ? [{ address: hostname }]
    : await dns.lookup(hostname, { all: true }).catch(() => []);
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw httpError(400, 'Custom API endpoints must resolve only to public IP addresses.');
  }
}

function replaceTemplateValues(value, values) {
  if (typeof value === 'string') {
    return value.replace(/\{\{(to|subject|html|text|senderName|senderEmail)\}\}/g, (_, key) => values[key] || '');
  }
  if (Array.isArray(value)) return value.map(item => replaceTemplateValues(item, values));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replaceTemplateValues(child, values)]));
  }
  return value;
}

function buildRequest(config, email) {
  const values = {
    to: email.to,
    subject: email.subject,
    html: email.html || '',
    text: email.text || '',
    senderName: config.senderName,
    senderEmail: config.senderEmail
  };
  const payload = config.provider === 'resend'
    ? {
        from: config.senderName
          ? `${config.senderName} <${config.senderEmail}>`
          : config.senderEmail,
        to: [email.to],
        subject: email.subject,
        ...(email.html ? { html: email.html } : {}),
        ...(email.text ? { text: email.text } : {})
      }
    : replaceTemplateValues(JSON.parse(config.payloadTemplate), values);

  const authValue = `${config.authPrefix}${config.apiKey}`;
  return {
    url: config.endpoint,
    headers: {
      'content-type': 'application/json',
      [config.authHeader]: authValue
    },
    body: JSON.stringify(payload)
  };
}

async function readJsonBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'Request body must be valid JSON.');
  }
}

function validateEmail(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw httpError(400, 'Email details must be a JSON object.');
  }
  const { to, subject, html, text } = input;
  if (typeof to !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    throw httpError(400, 'Enter a valid recipient email address.');
  }
  if (typeof subject !== 'string' || !subject.trim() || subject.length > 998) {
    throw httpError(400, 'Enter a subject (up to 998 characters).');
  }
  if (html !== undefined && typeof html !== 'string') throw httpError(400, 'HTML content must be text.');
  if (text !== undefined && typeof text !== 'string') throw httpError(400, 'Plain-text content must be text.');
  if (!(html || '').trim() && !(text || '').trim()) {
    throw httpError(400, 'Add HTML or plain-text content before sending.');
  }
  return { to, subject: subject.trim(), html: html || '', text: text || '' };
}

function sendJson(response, status, data) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  response.end(JSON.stringify(data));
}

const server = http.createServer(async (request, response) => {
  try {
    const origin = request.headers.origin;
    if (origin) {
      if (!ALLOWED_ORIGINS.has(origin)) throw httpError(403, 'This frontend origin is not allowed by the backend.');
      response.setHeader('access-control-allow-origin', origin);
      response.setHeader('vary', 'Origin');
      response.setHeader('access-control-allow-methods', 'GET, PUT, POST, OPTIONS');
      response.setHeader('access-control-allow-headers', 'content-type');
      response.setHeader('access-control-max-age', '600');
    }

    if (request.method === 'OPTIONS') {
      if (!origin) throw httpError(400, 'CORS preflight requires an allowed frontend origin.');
      response.writeHead(204);
      return response.end();
    }

    const url = new URL(request.url, 'http://backend.local');
    if (!url.pathname.startsWith('/api/')) throw httpError(404, 'Not found.');

    if (request.method === 'GET' && url.pathname === '/api/settings') {
      return sendJson(response, 200, publicSettings(await readConfig()));
    }

    if (request.method === 'PUT' && url.pathname === '/api/settings') {
      const current = await readConfig();
      const next = validateSettings(await readJsonBody(request), current);
      await writeConfig(next);
      return sendJson(response, 200, publicSettings(next));
    }

    if (request.method === 'POST' && url.pathname === '/api/send') {
      const config = await readConfig();
      const apiKey = config.provider === 'resend' ? process.env.RESEND_API_KEY : config.apiKey;
      if (!apiKey) throw httpError(400, 'Set RESEND_API_KEY on the backend before sending.');
      if (!config.senderEmail) throw httpError(400, 'Add a verified sender email in Settings before sending.');
      const email = validateEmail(await readJsonBody(request));
      if (config.provider === 'custom') {
        validateCustomEndpoint(config.endpoint);
        await assertPublicEndpoint(config.endpoint);
      }
      const outgoing = buildRequest(config, email);
      let upstream;
      try {
        upstream = await fetch(outgoing.url, {
          method: 'POST',
          headers: outgoing.headers,
          body: outgoing.body,
          redirect: 'error',
          signal: AbortSignal.timeout(20_000)
        });
      } catch (error) {
        if (error.name === 'TimeoutError') throw httpError(504, 'The email provider did not respond in time.');
        const reason = error.cause?.message || error.message;
        console.error('Could not connect to the configured email provider:', reason);
        throw httpError(502, `Could not connect to the configured email provider: ${reason}`);
      }
      if (!upstream.ok) {
        const raw = await upstream.text();
        let message = '';
        try {
          const parsed = JSON.parse(raw);
          const detail = parsed.message ?? parsed.error ?? parsed.code;
          message = typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : '';
        } catch {
          message = raw.trim();
        }
        message = message.slice(0, 300);
        console.error(`Email provider rejected the request (HTTP ${upstream.status}): ${message || 'No error details in response.'}`);
        throw httpError(502, message
          ? `The provider rejected the request (${upstream.status}): ${message}`
          : `The provider rejected the request (HTTP ${upstream.status}).`);
      }
      return sendJson(response, 200, { ok: true, message: 'Email accepted by the provider.' });
    }
    throw httpError(404, 'Not found.');
  } catch (error) {
    const status = error.status || 500;
    if (status === 500) console.error('Request failed:', error.message);
    if (!response.headersSent) sendJson(response, status, { error: status === 500 ? 'An internal server error occurred.' : error.message });
    else response.destroy();
  }
});

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('PORT must be a valid TCP port.');
}
for (const origin of ALLOWED_ORIGINS) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(`Invalid ALLOWED_ORIGINS entry: ${origin}`);
  }
  const localHttp = parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname);
  if ((!localHttp && parsed.protocol !== 'https:') || parsed.origin !== origin) {
    throw new Error(`ALLOWED_ORIGINS entries must be HTTPS origins or local HTTP origins without a path: ${origin}`);
  }
}

server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop the existing process or set PORT to a different value.`);
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, HOST, () => {
  console.log(`Email backend is listening on ${HOST}:${PORT}`);
  console.log(`Private provider settings are stored at ${CONFIG_FILE}`);
});
