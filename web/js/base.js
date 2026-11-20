// What the page's other scripts stand on: element lookup and creation, and the settings store.

const $ = id => document.getElementById(id);
const el = (tag, props) => Object.assign(document.createElement(tag), props);

// The service worker cannot read localStorage, so what it needs is also left in the cache it can read.
const SHARED = ['queue', 'schedule'];
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
    if (SHARED.includes(key) && 'caches' in window) prefsPut(key, value).catch(() => {});
  },
};
