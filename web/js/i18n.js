// The interface's languages and the one in use. Loaded before every other script, by the page and by
// the service worker alike, after the language files (lang/*.js). A new language is one such file,
// an entry here, and its name among the scripts of index.html and of sw.js.

const MESSAGES = {ru: LANG_RU, uk: LANG_UK, en: LANG_EN};

// The first of the system's preferred languages that the app speaks; English for any other.
function pickLanguage(preferred) {
  for (const tag of preferred ?? []) {
    const lang = tag.toLowerCase().split('-')[0];
    if (MESSAGES[lang]) return lang;
  }
  return 'en';
}

// LANG is the language's tag, for dates and numbers; T its phrases.
let LANG, T;
function setLanguage(lang) {
  LANG = lang;
  T = MESSAGES[lang];
  // A service worker has no document.
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
}
setLanguage(pickLanguage(navigator.languages ?? [navigator.language]));

// The form of a word that goes with a number: forms are named as Intl.PluralRules names them, and
// the last of them stands in for any that is not given.
const plural = (lang, n, forms) => forms[new Intl.PluralRules(lang).select(n)] ?? Object.values(forms).at(-1);

// A phrase as a sentence of its own.
const sentence = phrase => `${phrase[0].toLocaleUpperCase(LANG)}${phrase.slice(1)}.`;

// Puts the phrases into the markup: data-t names the phrase for an element's text, data-t-label the
// one for its accessible name, which is its tooltip too where the element has a title.
function localize() {
  document.title = T.title;
  for (const node of document.querySelectorAll('[data-t]')) node.textContent = T[node.dataset.t];
  for (const node of document.querySelectorAll('[data-t-label]')) {
    node.setAttribute('aria-label', T[node.dataset.tLabel]);
    if (node.hasAttribute('title')) node.title = T[node.dataset.tLabel];
  }
}
