import { state, render, setupStatePanel } from './common.js';
import { mountSwitcher } from './switcher.js';
import * as A from './variant-a.js';
import * as B from './variant-b.js';
import * as C from './variant-c.js';
import * as D from './variant-d.js';
import * as E from './variant-e.js';

const variants = { A, B, C, D, E };
const key = new URLSearchParams(location.search).get('variant') ?? 'A';
const variant = variants[key] ?? A;

state.variant = `${key} · ${variant.name}`;
setupStatePanel();
variant.mount(document.getElementById('app'));
mountSwitcher(document.getElementById('switcher'), Object.fromEntries(Object.entries(variants).map(([k, v]) => [k, v.name])), key);
render();
