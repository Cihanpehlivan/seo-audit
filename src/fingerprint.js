// Content fingerprints for duplicate detection.
import { createHash } from 'node:crypto';

export function exactHash(text) {
  return createHash('sha1').update(text.toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);
}

function fnv32(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

// 64-bit simhash stored as 16 hex chars (two 32-bit halves, no BigInt needed).
export function simhash(text) {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  if (words.length < 3) return null;
  const v = new Int32Array(64);
  for (let i = 0; i <= words.length - 3; i++) {
    const sh = words[i] + ' ' + words[i + 1] + ' ' + words[i + 2];
    const a = fnv32(sh, 2166136261), b = fnv32(sh, 0x9747b28c);
    for (let bit = 0; bit < 32; bit++) {
      v[bit] += (a >>> bit) & 1 ? 1 : -1;
      v[bit + 32] += (b >>> bit) & 1 ? 1 : -1;
    }
  }
  let hi = 0, lo = 0;
  for (let bit = 0; bit < 32; bit++) { if (v[bit] > 0) lo |= 1 << bit; if (v[bit + 32] > 0) hi |= 1 << bit; }
  return (hi >>> 0).toString(16).padStart(8, '0') + (lo >>> 0).toString(16).padStart(8, '0');
}

function popcount(x) { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; }

export function hamming(a, b) {
  return popcount((parseInt(a.slice(0, 8), 16) ^ parseInt(b.slice(0, 8), 16)) >>> 0)
    + popcount((parseInt(a.slice(8), 16) ^ parseInt(b.slice(8), 16)) >>> 0);
}
