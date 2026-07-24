// /USD_Viewer/core/AssetDB.js
// Canonical asset database: one payload per logical file plus lightweight aliases.

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml',
  usda: 'text/plain', usd: 'text/plain', xml: 'text/xml', mjcf: 'text/xml', obj: 'text/plain', mtl: 'text/plain'
};

function cleanRaw(s) {
  let t = String(s || '').trim();
  if ((t.startsWith('@') && t.endsWith('@')) || (t.startsWith('"') && t.endsWith('"'))) t = t.slice(1, -1);
  try { t = decodeURIComponent(t); } catch (_) {}
  t = t.replace(/\\/g, '/').replace(/^file:\/\//i, '').replace(/^\.+\//, '').replace(/^\/+/,'');
  t = t.replace(/^package:\/\//i, '');
  return t;
}
export function normKey(s) { return cleanRaw(s).toLowerCase(); }
export function basenameNoQuery(p) { const q = cleanRaw(p).split('?')[0].split('#')[0]; return q.split('/').pop() || ''; }
export function extOf(p) { const q = basenameNoQuery(p); const i = q.lastIndexOf('.'); return i >= 0 ? q.slice(i + 1).toLowerCase() : ''; }
export function dropPackagePrefix(k) { return normKey(k).replace(/^package:\/\//i, ''); }

export function variantsFor(path) {
  const out = new Set();
  const raw0 = cleanRaw(path);
  if (!raw0) return [];
  const raws = [raw0, raw0.replace(/^\.\//,''), raw0.replace(/^\.\.\//,'')];
  for (const raw of raws) {
    const p = normKey(raw);
    const noPkg = p.replace(/^package:\/\//i, '');
    const base = basenameNoQuery(noPkg).toLowerCase();
    out.add(p); out.add(noPkg); out.add(base);
    const parts = noPkg.split('/').filter(Boolean);
    for (let i = 1; i < parts.length; i++) out.add(parts.slice(i).join('/'));
    for (let i = 0; i < parts.length; i++) out.add(parts.slice(i).join('/'));
    if (base) {
      const baseSpace = base.replace(/%20/g, ' ');
      const baseUnderscore = baseSpace.replace(/\s+/g, '_');
      const baseSpacesFromUnder = baseUnderscore.replace(/_/g, ' ');
      const baseCompact = baseSpace.replace(/[\s_\-]+/g, '');
      const baseNoExt = baseSpace.replace(/\.[^.]+$/, '');
      out.add(baseSpace);
      out.add(baseUnderscore);
      out.add(baseSpacesFromUnder);
      out.add(baseCompact);
      out.add(baseNoExt);
      out.add(baseNoExt.replace(/[\s_\-]+/g, ''));
    }
  }
  return Array.from(out).filter(Boolean);
}

export function dataURLFor(key, val) {
  const v = String(val || '');
  if (!v) return '';
  if (/^(data:|blob:|https?:\/\/)/i.test(v)) return v;
  const mime = MIME[extOf(key)] || 'application/octet-stream';
  return `data:${mime};base64,${v}`;
}

function sampledHash(value) {
  if (typeof value !== 'string') return '';
  const n = value.length;
  let h = 2166136261 >>> 0;
  if (!n) return '0:0';
  const samples = Math.min(96, n);
  for (let i = 0; i < samples; i++) {
    const pos = samples === 1 ? 0 : Math.floor(i * (n - 1) / (samples - 1));
    h ^= value.charCodeAt(pos);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `${n}:${h}`;
}

function rawValuesEqual(a, b) {
  if (a === b) return true;
  if (typeof a === 'string' && typeof b === 'string') return a === b;
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    if (a.byteLength !== b.byteLength) return false;
    for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  if (a instanceof ArrayBuffer && b instanceof ArrayBuffer) {
    return rawValuesEqual(new Uint8Array(a), new Uint8Array(b));
  }
  return false;
}

/**
 * Returns one canonical payload per unique file content. Alias paths are kept as
 * tiny references, never as repeated Base64/data-URL strings.
 */
export function canonicalizeAssetEntries(assetDB = {}) {
  const canonical = new Map();
  const aliases = new Map();
  const buckets = new Map();
  let duplicatesRemoved = 0;

  for (const [rawKey, rawValue] of Object.entries(assetDB || {})) {
    if (rawValue == null || rawValue === '') continue;
    const key = cleanRaw(rawKey);
    if (!key) continue;
    const signature = typeof rawValue === 'string'
      ? `s:${sampledHash(rawValue)}`
      : (rawValue instanceof Uint8Array
          ? `u8:${rawValue.byteLength}:${rawValue[0] || 0}:${rawValue[rawValue.byteLength - 1] || 0}`
          : (rawValue instanceof ArrayBuffer ? `ab:${rawValue.byteLength}` : `o:${typeof rawValue}`));
    const candidates = buckets.get(signature) || [];
    let canonicalKey = '';
    for (const candidateKey of candidates) {
      if (rawValuesEqual(canonical.get(candidateKey), rawValue)) { canonicalKey = candidateKey; break; }
    }
    if (!canonicalKey) {
      canonicalKey = key;
      canonical.set(canonicalKey, rawValue);
      candidates.push(canonicalKey);
      buckets.set(signature, candidates);
    } else {
      duplicatesRemoved++;
    }
    aliases.set(key, canonicalKey);
  }
  return { canonical, aliases, duplicatesRemoved };
}

export function buildAssetDB(assetDB = {}) {
  const compact = canonicalizeAssetEntries(assetDB);
  const canonicalData = new Map();
  const aliasToCanonical = new Map();
  const byBase = new Map();
  const originalKeys = new Map();

  for (const [canonicalKey, rawValue] of compact.canonical.entries()) {
    canonicalData.set(canonicalKey, dataURLFor(canonicalKey, rawValue));
  }
  for (const [alias, canonicalKey] of compact.aliases.entries()) {
    for (const variant of variantsFor(alias)) {
      if (!aliasToCanonical.has(variant)) aliasToCanonical.set(variant, canonicalKey);
      if (!originalKeys.has(variant)) originalKeys.set(variant, alias);
      const base = basenameNoQuery(variant).toLowerCase();
      if (base) {
        const arr = byBase.get(base) || [];
        if (!arr.includes(canonicalKey)) arr.push(canonicalKey);
        byBase.set(base, arr);
      }
    }
  }

  const resolveCanonical = (path) => {
    for (const variant of variantsFor(path)) {
      const canonicalKey = aliasToCanonical.get(variant);
      if (canonicalKey) return canonicalKey;
    }
    const base = basenameNoQuery(path).toLowerCase();
    const direct = byBase.get(base) || [];
    if (direct.length) return direct[0];
    if (base) {
      const baseNoExt = base.replace(/\.[^.]+$/, '');
      const normalize = x => String(x || '').toLowerCase().replace(/\.[^.]+$/, '').replace(/[%\s_\-]+/g, '');
      const baseNorm = normalize(base);
      for (const [candidateBase, canonicalKeys] of byBase.entries()) {
        const candidateNoExt = candidateBase.replace(/\.[^.]+$/, '');
        const candidateNorm = normalize(candidateBase);
        if (candidateBase === base || candidateNoExt === baseNoExt || candidateBase.includes(baseNoExt) || baseNoExt.includes(candidateNoExt) || candidateNorm === baseNorm || candidateNorm.includes(baseNorm) || baseNorm.includes(candidateNorm)) {
          if (canonicalKeys.length) return canonicalKeys[0];
        }
      }
    }
    return '';
  };

  return {
    // Kept for compatibility. It contains only canonical entries, not aliases.
    byKey: Object.fromEntries(canonicalData.entries()),
    byBase,
    originalKeys,
    aliases: aliasToCanonical,
    duplicatesRemoved: compact.duplicatesRemoved,
    has(path) { return !!this.get(path); },
    get(path) {
      const canonicalKey = resolveCanonical(path);
      return canonicalKey ? canonicalData.get(canonicalKey) : undefined;
    },
    keys() { return Array.from(canonicalData.keys()); }
  };
}
export default { buildAssetDB, canonicalizeAssetEntries, normKey, variantsFor, dataURLFor, extOf, basenameNoQuery };
