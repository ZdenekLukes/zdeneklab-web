// Browser-side Live transport.
//
// Product semantics are transport-independent. HTTP talks to the standalone
// server; GitHub is the GitHub Actions POC. Switching later is one config
// value / URL query parameter, not an architecture change.
//
// OPENAI_API_KEY never enters the browser. The optional GitHub POC token is a
// separate, least-privilege repository token used only against api.github.com.

const GH_TOKEN_KEY = 'concept-sketcher.github-poc-token';

export function liveConfig(url = new URL(location.href)) {
  const live = url.searchParams.get('live') === '1';
  const transport = url.searchParams.get('transport') || 'http';
  const metaEndpoint = typeof document !== 'undefined' ? document.querySelector('meta[name="concept-sketcher-api"]')?.content || '' : '';
  const configured = url.searchParams.get('api') || metaEndpoint;
  const endpoint = configured || (live ? '/api/interpret' : '');
  const seed = url.searchParams.get('seed') || '';
  return {
    live, transport, endpoint, seed,
    github: {
      owner: url.searchParams.get('gh_owner') || 'ZdenekLukes',
      repo: url.searchParams.get('gh_repo') || 'concept-sketcher',
      ref: url.searchParams.get('gh_ref') || 'main',
      workflow: url.searchParams.get('gh_workflow') || 'github-live-poc.yml',
      resultBranch: url.searchParams.get('gh_results') || 'live-results',
      resultDir: 'github-live-results',
      pollMs: 2000,
      timeoutMs: 180000,
    },
  };
}

export function storedGitHubToken(storage = localStorage) {
  try { return storage.getItem(GH_TOKEN_KEY) || ''; } catch { return ''; }
}
export function storeGitHubToken(token, storage = localStorage) {
  if (!token || typeof token !== 'string') throw new Error('GitHub token is empty.');
  try { storage.setItem(GH_TOKEN_KEY, token.trim()); }
  catch { throw new Error('Browser storage is unavailable.'); }
}
export function clearGitHubToken(storage = localStorage) {
  try { storage.removeItem(GH_TOKEN_KEY); } catch { /* no-op */ }
}

async function responseJson(res) {
  try { return await res.json(); } catch { return null; }
}

export async function requestHttpIntent(endpoint, { utterance, model, recent = [] }, fetchImpl = fetch) {
  if (!endpoint) throw new Error('Live AI backend is not configured yet.');
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ utterance, model, recent }),
  });
  const body = await responseJson(res);
  if (!res.ok) throw new Error(body?.error || `Live AI backend returned HTTP ${res.status}`);
  if (!body || typeof body.intent !== 'object') throw new Error('Live AI backend returned no intent object.');
  return JSON.stringify(body.intent);
}

function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}
function base64ToUtf8(text) {
  const bin = atob(String(text || '').replace(/\n/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const requestIdDefault = () => `${Date.now()}-${crypto.randomUUID()}`;

function ghHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

export async function requestGitHubIntent(config, input, options = {}) {
  const gh = config.github || config;
  const fetchImpl = options.fetchImpl || fetch;
  const sleep = options.sleep || sleepDefault;
  const token = options.token || storedGitHubToken(options.storage || localStorage);
  if (!token) {
    const e = new Error('GitHub POC needs a repository token once on this device.');
    e.code = 'GITHUB_TOKEN_REQUIRED';
    throw e;
  }

  const requestId = options.requestId || requestIdDefault();
  const payloadText = JSON.stringify({
    utterance: input.utterance,
    model: input.model,
    recent: Array.isArray(input.recent) ? input.recent.slice(-12) : [],
  });
  const payload = utf8ToBase64(payloadText);
  if (payload.length > 60000) throw new Error('Concept is too large for the GitHub Actions POC transport.');

  const api = `https://api.github.com/repos/${encodeURIComponent(gh.owner)}/${encodeURIComponent(gh.repo)}`;
  options.onProgress?.('GitHub POC: queuing AI job…');

  const dispatch = await fetchImpl(`${api}/actions/workflows/${encodeURIComponent(gh.workflow)}/dispatches`, {
    method: 'POST',
    headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ref: gh.ref || 'main',
      inputs: { request_id: requestId, payload_b64: payload },
    }),
  });
  if (!dispatch.ok) {
    const body = await responseJson(dispatch);
    const e = new Error(body?.message || `GitHub dispatch failed (HTTP ${dispatch.status})`);
    if (dispatch.status === 401 || dispatch.status === 403) e.code = 'GITHUB_AUTH_FAILED';
    throw e;
  }

  const started = Date.now();
  const timeoutMs = gh.timeoutMs || 180000;
  const pollMs = gh.pollMs || 2000;
  const resultPath = `${gh.resultDir || 'github-live-results'}/${requestId}.json`;

  while (Date.now() - started < timeoutMs) {
    options.onProgress?.(`GitHub POC: AI job running… ${Math.round((Date.now() - started) / 1000)} s`);
    const url = `${api}/contents/${resultPath}?ref=${encodeURIComponent(gh.resultBranch || 'live-results')}&_=${Date.now()}`;
    const res = await fetchImpl(url, { headers: { ...ghHeaders(token), 'Cache-Control': 'no-cache' } });

    if (res.status === 404) { await sleep(pollMs); continue; }
    const body = await responseJson(res);
    if (!res.ok) {
      const e = new Error(body?.message || `GitHub result read failed (HTTP ${res.status})`);
      if (res.status === 401 || res.status === 403) e.code = 'GITHUB_AUTH_FAILED';
      throw e;
    }

    let result;
    try { result = JSON.parse(base64ToUtf8(body.content)); }
    catch { throw new Error('GitHub POC returned an unreadable result.'); }

    if (!result.ok) throw new Error(result.error || 'GitHub POC AI job failed.');
    if (!result.response || typeof result.response.intent !== 'object') throw new Error('GitHub POC returned no intent object.');
    options.onProgress?.(`GitHub POC: response received in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    return JSON.stringify(result.response.intent);
  }

  throw new Error(`GitHub POC timed out after ${Math.round(timeoutMs / 1000)} s.`);
}

// Backward compatible: passing a string uses the direct HTTP transport.
export async function requestLiveIntent(target, input, fetchOrOptions = fetch) {
  if (typeof target === 'string') {
    const fetchImpl = typeof fetchOrOptions === 'function' ? fetchOrOptions : (fetchOrOptions.fetchImpl || fetch);
    return requestHttpIntent(target, input, fetchImpl);
  }
  const options = typeof fetchOrOptions === 'function' ? { fetchImpl: fetchOrOptions } : fetchOrOptions;
  if (target.transport === 'github') return requestGitHubIntent(target, input, options);
  return requestHttpIntent(target.endpoint, input, options.fetchImpl || fetch);
}
