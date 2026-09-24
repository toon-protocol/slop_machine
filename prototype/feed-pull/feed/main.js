import { state, render, setupStatePanel } from './common.js';
import { mountSwitcher } from './switcher.js';
import * as A from './variant-a.js';
import * as B from './variant-b.js';
import * as C from './variant-c.js';
import * as D from './variant-d.js';
import * as E from './variant-e.js';

const variants = { A, B, C, D, E };
// The home-screen app launches with a baked-in URL, so there the last-picked variant wins over the URL's.
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
const param = new URLSearchParams(location.search).get('variant');
let stored = null;
try {
  stored = localStorage.getItem('variant');
} catch {}
const picked = (standalone ? stored ?? param : param ?? stored) ?? 'E';
const key = variants[picked] ? picked : 'E';
const variant = variants[key];
try {
  localStorage.setItem('variant', key);
} catch {}

state.variant = `${key} · ${variant.name}`;
setupStatePanel();
variant.mount(document.getElementById('app'));
mountSwitcher(document.getElementById('switcher'), Object.fromEntries(Object.entries(variants).map(([k, v]) => [k, v.name])), key);
render();
