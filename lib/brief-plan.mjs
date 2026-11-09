// 純資料驗證；不執行說明檔指令。
const obj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const refPattern = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
export function reference(value, results) {
  if (!refPattern.test(value) || value.split('.').some(k => unsafeKeys.has(k))) throw Error('invalid reference');
  const [id, ...keys] = value.split('.');
  let v = results[id];
  for (const key of keys) {
    if ((!obj(v) && !Array.isArray(v)) || !Object.hasOwn(v, key)) throw Error('missing reference');
    v = v[key];
  }
  if (v === undefined) throw Error('missing reference');
  return v;
}
export function render(value, results, wallet, encode = false) {
  if (typeof value === 'string') return value.replace(/\{([^{}]+)\}/g, (_, ref) => {
    const v = ref === 'wallet' ? wallet : reference(ref, results);
    if (!['string', 'number', 'boolean'].includes(typeof v)) throw Error('non-scalar template');
    return encode ? encodeURIComponent(String(v)) : String(v);
  });
  if (Array.isArray(value)) return value.map(v => render(v, results, wallet, encode));
  if (obj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, render(v, results, wallet, encode)]));
  return value;
}
export function safePath(path, origin) {
  return typeof path === 'string' && !/[\\\s\u0000-\u001f]/.test(path) && !path.startsWith('//') &&
    !/^[a-z][a-z0-9+.-]*:/i.test(path) && new URL(path, origin).origin === origin;
}
export function validatePlan(plan, origin, brief, allowedPaths = []) {
  try {
    if (!obj(plan) || !/^0x[\da-f]{40}$/i.test(plan.contract) || !/^0x[\da-f]{8}$/i.test(plan.selector) ||
        !Array.isArray(plan.steps) || !plan.steps.length || plan.steps.length > 10) return false;
    const ids = new Set();
    if (plan.steps.filter(step => step?.type === 'tweet').length > 1) return false;
    const templates = v => {
      if (typeof v === 'string') {
        const stripped = v.replace(/\{([^{}]+)\}/g, (_, r) => {
          if (r !== 'wallet' && (!refPattern.test(r) || !ids.has(r.split('.')[0]) || r.split('.').some(k => unsafeKeys.has(k)))) throw Error('forward reference');
          return '';
        });
        if (/[{}]/.test(stripped)) throw Error('invalid template');
      } else if (Array.isArray(v)) v.forEach(templates);
      else if (obj(v)) for (const [k, val] of Object.entries(v)) {
        if (unsafeKeys.has(k) || /[{}]/.test(k)) throw Error('invalid key');
        templates(val);
      }
    };
    for (const step of plan.steps) {
      if (!obj(step) || !/^[A-Za-z][A-Za-z0-9_]*$/.test(step.id) || unsafeKeys.has(step.id) || ids.has(step.id)) return false;
      const fields = {get:['path'], post:['path','body'], solve:['expr'], tweet:['text']}[step.type];
      if (!Array.isArray(fields) || Object.keys(step).some(k => !['id','type',...fields].includes(k)) || fields.some(k => !Object.hasOwn(step,k))) return false;
      templates(step);
      if (['get','post'].includes(step.type) && !safePath(step.path, origin)) return false;
      if (['get','post'].includes(step.type) && brief !== undefined) {
        const pathname = new URL(step.path, origin).pathname;
        const inBrief = brief.split(pathname).some((part, i, parts) => i < parts.length-1 &&
          !/[A-Za-z0-9_/-]/.test(part.at(-1) ?? '') && !/[A-Za-z0-9_/-]/.test(parts[i+1][0] ?? ''));
        if (!allowedPaths.includes(pathname) && !inBrief) return false;
      }
      if (step.type === 'post' && !obj(step.body)) return false;
      if (step.type === 'tweet' && typeof step.text !== 'string') return false;
      if (step.type === 'solve') {
        if (typeof step.expr !== 'string') return false;
        if (!step.expr.includes('{')) solve(step.expr);
      }
      ids.add(step.id);
    }
    return typeof plan.tx === 'string' && refPattern.test(plan.tx) && ids.has(plan.tx.split('.')[0]) && !plan.tx.split('.').some(k => unsafeKeys.has(k));
  } catch { return false; }
}
export function solve(expr) {
  const m = /^\s*(-?\d+)\s*([+\-x×*])\s*(-?\d+)\s*$/.exec(expr);
  if (!m) throw Error('invalid arithmetic');
  const a = BigInt(m[1]), b = BigInt(m[3]);
  return (m[2] === '+' ? a+b : m[2] === '-' ? a-b : a*b).toString();
}
export function tweetCode(results) {
  const codes = new Set();
  const walk = v => { if (obj(v) || Array.isArray(v)) for (const [k,x] of Object.entries(v)) {
    if (/^(tweet|post|share)[_-]?code$/i.test(k) && typeof x === 'string' && /^[a-z0-9]{6,32}$/i.test(x)) codes.add(x);
    walk(x);
  }};
  walk(results);
  return codes.size === 1 ? [...codes][0] : null;
}
export function validPost(text, brief, origin, results) {
  if (typeof text !== 'string') return false;
  const code = tweetCode(results);
  if (code === null || !text.includes(code)) return false;
  const mentions = text.match(/@[A-Za-z0-9_]+/g) ?? [];
  const allowed = brief.match(/@[A-Za-z0-9_]+/g) ?? [];
  if (mentions.length > 2 || mentions.some(m => !allowed.includes(m))) return false;
  const urls = text.match(/(?:[a-z][a-z0-9+.-]*:\/\/[^\s]+|(?<![\p{L}\p{N}_-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+(?:\p{L}{2,}|xn--[a-z0-9-]+)(?![\p{L}\p{N}_-])[^\s]*)/giu) ?? [];
  if (urls.length > 1 || !urls.every(u => {
    try { return new URL(u.includes('://') ? u : `https://${u}`).host === new URL(origin).host; }
    catch { return false; }
  })) return false;
  const plain = urls.length ? text.replace(urls[0], '') : text;
  let length = urls.length * 23;
  for (const char of plain) {
    const cp = char.codePointAt(0);
    length += cp <= 0x10ff || (cp >= 0x2000 && cp <= 0x200d) ||
      (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037) ? 1 : 2;
  }
  return length <= 280;
}
export function validTx(tx, plan, brief) {
  const word = s => new RegExp(`\\b${s}\\b`, 'i').test(brief);
  try { return obj(tx) && typeof tx.to === 'string' && tx.to.toLowerCase() === plan.contract.toLowerCase() &&
    word(plan.contract) && word(plan.selector) && /^0x(?:[\da-f]{2}){4,}$/i.test(tx.data) &&
    tx.data.slice(0,10).toLowerCase() === plan.selector.toLowerCase() &&
    ['string','number'].includes(typeof tx.value) && String(tx.value).trim() !== '' && BigInt(tx.value) === 0n &&
    (tx.chainId === undefined || String(tx.chainId) === '56'); } catch { return false; }
}
export function validPreview(p) {
  const d = p?.data, s = d?.simulationResult, r = d?.risks;
  const numeric = n => (typeof n === 'number' || (typeof n === 'string' && n.trim() !== '')) && Number.isFinite(Number(n));
  return p?.success === true && typeof d?.requestId === 'string' && d.requestId.length > 0 &&
    typeof s?.simulationCode === 'string' && Array.isArray(s.balanceChanges) && s.balanceChanges.every(c => numeric(c?.amount ?? c?.change)) &&
    Array.isArray(s.allowanceChanges) && Array.isArray(s.authorityChanges) && obj(r) && Array.isArray(r.riskDetails) &&
    (obj(r.addresses) || Array.isArray(r.addresses)) && Object.values(r.addresses).every(a => numeric(a?.riskLevel)) && typeof d.requireConfirmation === 'boolean';
}
