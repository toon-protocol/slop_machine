// PROTOTYPE, throwaway. Answers ticket #16 "How does a Slop ask for a Purchase?"
// The Purchase round trip: Slop calls slop.pay() → shim posts `slop-pay` to the Feed → the Feed checks it, draws a
// confirmation sheet the Slop can't reach, pays through a fake connector → posts a `slop-receipt` back.
// Three sheet designs, switchable via `?sheet=A|B|C`. Pull mechanics come from variant E.
import { state, slopAt, event, toast, render, hooks, SLOP_ORIGIN } from './common.js';

const TIERS = [1, 5, 10, 25]; // cents; 25 is the cap
const TAP_WINDOW_MS = 1500; // a request must follow a forwarded tap this closely, like a popup blocker
const PAY_TIMEOUT_MS = 8000; // no FULFILL by then → failed
const REFILL_EVERY_MS = 60_000; // rate limit on sponsored Refills
const REFILL = 1.0;
const LABEL_MAX = 40;

let current = null; // the one Purchase in flight

export function mountPurchases(app, sheetKey) {
  const sheet = SHEETS[sheetKey];

  const net = document.getElementById('netToggle');
  const modes = ['ok', 'reject', 'slow'];
  net.addEventListener('click', () => {
    state.net = modes[(modes.indexOf(state.net) + 1) % modes.length];
    net.textContent = `net: ${state.net}`;
    render();
  });

  addEventListener('message', (e) => {
    if (e.origin !== SLOP_ORIGIN || e.data?.type !== 'slop-pay') return;
    const { id, tier, item, label } = e.data;
    const reply = (status, extra = {}) => {
      e.source.postMessage({ type: 'slop-receipt', id, status, tier, item, ...extra }, SLOP_ORIGIN);
      event(`→ receipt ${status}${extra.reason ? ` (${extra.reason})` : ''} for ${item} ${tier}¢`);
    };
    event(`← slop-pay ${tier}¢ ${item}`);

    // Refusals: answered at once, no sheet drawn.
    if (e.source !== hooks.currentFrame()?.contentWindow) return reply('refused', { reason: 'not-on-screen' });
    if (typeof tier === 'number' && tier > 25) return reply('refused', { reason: 'over-cap' });
    if (!TIERS.includes(tier)) return reply('refused', { reason: 'bad-tier' });
    if (current) return reply('refused', { reason: 'busy' });
    const tap = state.lastTap;
    if (!tap || tap.index !== state.index || Date.now() - tap.at > TAP_WINDOW_MS) return reply('refused', { reason: 'no-tap' });

    const slop = slopAt(state.index);
    const cents = tier;
    current = { id, reply };
    state.sheetOpen = true;

    const close = () => {
      ui.el.remove();
      current = null;
      state.sheetOpen = false;
      render();
    };
    const ctx = {
      icon: slop.icon,
      title: slop.title,
      creator: slop.creator,
      label: label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX - 1)}…` : label || item,
      cents,
      price: `${cents}¢`,
      get runway() {
        return state.balance;
      },
      get short() {
        return state.balance + 1e-9 < cents / 100;
      },
      get refillWait() {
        return Math.max(0, Math.ceil((state.refillAt + REFILL_EVERY_MS - Date.now()) / 1000));
      },
      cancel(reason = 'cancelled') {
        if (current?.id !== id || ctx.paying) return;
        reply('declined', { reason });
        close();
      },
      refill() {
        if (ctx.refillWait) return;
        state.refillAt = Date.now();
        ui.phase('refilling');
        setTimeout(() => {
          state.balance = Math.round((state.balance + REFILL) * 100) / 100;
          event(`refill +${REFILL.toFixed(2)} (sponsored)`);
          toast(`+${REFILL.toFixed(2)} Runway`);
          ui.phase('ask');
        }, 900);
      },
      pay() {
        if (ctx.paying || ctx.short) return;
        ctx.paying = true;
        ui.phase('paying');
        event(`paying ${cents}¢ on the ${cents}¢ route (net: ${state.net})`);
        const finish = (ok, reason) => {
          clearTimeout(timer);
          if (ok) {
            state.balance = Math.round((state.balance - cents / 100) * 100) / 100; // Runway moves only on FULFILL
            state.purchases++;
            state.creators[slop.creator] = (state.creators[slop.creator] ?? 0) + cents / 100;
            reply('paid', { purchase: `pur_${Math.random().toString(36).slice(2, 10)}` });
            toast(`−${cents}¢ → ${slop.creator}`);
            ui.phase('paid');
            setTimeout(close, 700);
          } else {
            reply('failed', { reason });
            ui.phase('failed', reason === 'timeout' ? 'No answer from the network. You were not charged.' : 'The payment was rejected. You were not charged.');
            setTimeout(close, 1800);
          }
        };
        const timer = setTimeout(() => finish(false, 'timeout'), PAY_TIMEOUT_MS);
        if (state.net === 'ok') setTimeout(() => finish(true), 600);
        if (state.net === 'reject') setTimeout(() => finish(false, 'rejected'), 600);
      },
    };
    const ui = sheet.build(ctx);
    app.appendChild(ui.el);
    ui.phase('ask');
    render();
  });
}

const runwayLine = (ctx) =>
  ctx.short ? `<span class="p-short">Runway ${ctx.runway.toFixed(2)}: not enough</span>` : `Runway ${ctx.runway.toFixed(2)} → ${(ctx.runway - ctx.cents / 100).toFixed(2)}`;
const refillButton = (ctx) => (ctx.refillWait ? `<button class="p-ghost" disabled>Refill in ${ctx.refillWait}s</button>` : `<button class="p-refill" data-act="refill">Refill $${REFILL.toFixed(2)} (free)</button>`);
const esc = (s) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const bind = (el, ctx) => el.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', (e) => (e.stopPropagation(), ctx[b.dataset.act]())));

// A · Bottom sheet, tap to pay. Classic payment-sheet shape. The Pay button arms after a beat, so a tap already
// travelling toward the game can't land on it. Backdrop tap or swipe-down cancels.
const A = {
  name: 'Bottom sheet, tap Pay',
  build(ctx) {
    const el = document.createElement('div');
    el.className = 'pa';
    const phase = (p, msg) => {
      const body = {
        ask: () => `
          <div class="pa-who">${ctx.icon} <b>${esc(ctx.title)}</b> <small>by ${ctx.creator}</small></div>
          <div class="pa-item">“${esc(ctx.label)}”<small>item named by the Slop</small></div>
          <div class="pa-price">${ctx.price}<small>USDC · all of it to the Creator</small></div>
          <div class="pa-runway">${runwayLine(ctx)}</div>
          ${ctx.short ? refillButton(ctx) : `<button class="pa-pay" data-act="pay" disabled>Pay ${ctx.price}</button>`}
          <button class="p-ghost" data-act="cancel">Not now</button>`,
        refilling: () => `<div class="p-status">Refilling Runway…</div>`,
        paying: () => `<div class="p-status"><span class="p-spin"></span>Paying ${ctx.price}…</div>`,
        paid: () => `<div class="p-status p-ok">✓ Paid ${ctx.price}</div>`,
        failed: () => `<div class="p-status p-bad">✗ ${msg}</div>`,
      }[p]();
      el.innerHTML = `<div class="pa-back"></div><div class="pa-sheet"><div class="pa-grab"></div>${body}</div>`;
      el.querySelector('.pa-back').addEventListener('click', () => ctx.cancel());
      bind(el, ctx);
      const pay = el.querySelector('.pa-pay');
      if (pay) setTimeout(() => (pay.disabled = false), 500);
      const sh = el.querySelector('.pa-sheet');
      let y0 = null;
      sh.addEventListener('touchstart', (e) => (y0 = e.touches[0].clientY), { passive: true });
      sh.addEventListener('touchmove', (e) => y0 != null && (sh.style.transform = `translateY(${Math.max(0, e.touches[0].clientY - y0)}px)`), { passive: true });
      sh.addEventListener('touchend', (e) => {
        const dy = e.changedTouches[0].clientY - y0;
        y0 = null;
        sh.style.transform = '';
        if (dy > 80) ctx.cancel();
      });
    };
    return { el, phase };
  },
};

// B · Hold to pay. A centred card over a dimmed Slop; the pay control only fires on a deliberate press-and-hold,
// so no stray tap or flick can ever pay.
const B = {
  name: 'Centre card, hold to pay',
  build(ctx) {
    const el = document.createElement('div');
    el.className = 'pb';
    const HOLD = 800;
    const phase = (p, msg) => {
      const body = {
        ask: () => `
          <button class="pb-x" data-act="cancel">✕</button>
          <div class="pb-icon">${ctx.icon}</div>
          <div class="pb-ask"><b>${esc(ctx.title)}</b> asks for</div>
          <div class="pb-price">${ctx.price}</div>
          <div class="pb-item">for “${esc(ctx.label)}”</div>
          <div class="pb-meta">to ${ctx.creator} · ${runwayLine(ctx)}</div>
          ${ctx.short ? refillButton(ctx) : `<button class="pb-hold"><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="46"/></svg><span>hold to pay</span></button>`}`,
        refilling: () => `<div class="p-status">Refilling Runway…</div>`,
        paying: () => `<div class="p-status"><span class="p-spin"></span>Paying ${ctx.price}…</div>`,
        paid: () => `<div class="p-status p-ok">✓ Paid ${ctx.price}</div>`,
        failed: () => `<div class="p-status p-bad">✗ ${msg}</div>`,
      }[p]();
      el.innerHTML = `<div class="pb-card">${body}</div>`;
      bind(el, ctx);
      const hold = el.querySelector('.pb-hold');
      if (!hold) return;
      let timer = null;
      const start = (e) => {
        e.preventDefault();
        hold.classList.add('on');
        timer = setTimeout(() => ctx.pay(), HOLD);
      };
      const stop = () => (clearTimeout(timer), hold.classList.remove('on'));
      hold.addEventListener('pointerdown', start);
      hold.addEventListener('pointerup', stop);
      hold.addEventListener('pointerleave', stop);
      hold.addEventListener('pointercancel', stop);
      hold.addEventListener('contextmenu', (e) => e.preventDefault());
    };
    return { el, phase };
  },
};

// C · Top banner, slide to pay. The Slop stays visible and playable underneath (only Pulls are paused); the banner
// slides in from the top, away from the thumb, and pays on a horizontal slide, which is orthogonal to a Pull flick.
// It expires on its own after 20s.
const C = {
  name: 'Top banner, slide to pay',
  build(ctx) {
    const el = document.createElement('div');
    el.className = 'pc';
    const EXPIRE = 20000;
    const expiry = setTimeout(() => ctx.cancel('expired'), EXPIRE);
    const t0 = Date.now();
    const phase = (p, msg) => {
      if (p !== 'ask' && p !== 'refilling') clearTimeout(expiry);
      const body = {
        ask: () => `
          <div class="pc-row"><span class="pc-icon">${ctx.icon}</span>
            <div class="pc-text"><b>${ctx.price}</b> for “${esc(ctx.label)}”<small>${esc(ctx.title)} · ${ctx.creator} · ${runwayLine(ctx)}</small></div>
            <button class="pc-x" data-act="cancel">✕</button></div>
          ${ctx.short ? refillButton(ctx) : `<div class="pc-track"><div class="pc-thumb">›</div><span>slide to pay ${ctx.price}</span></div>`}
          <div class="pc-timer" style="animation-duration:${EXPIRE}ms; animation-delay:-${Date.now() - t0}ms"></div>`,
        refilling: () => `<div class="p-status">Refilling Runway…</div>`,
        paying: () => `<div class="p-status"><span class="p-spin"></span>Paying ${ctx.price}…</div>`,
        paid: () => `<div class="p-status p-ok">✓ Paid ${ctx.price}</div>`,
        failed: () => `<div class="p-status p-bad">✗ ${msg}</div>`,
      }[p]();
      el.innerHTML = body;
      bind(el, ctx);
      const track = el.querySelector('.pc-track');
      if (!track) return;
      const thumb = track.querySelector('.pc-thumb');
      let x0 = null;
      const max = () => track.clientWidth - thumb.offsetWidth - 8;
      thumb.addEventListener('pointerdown', (e) => (thumb.setPointerCapture(e.pointerId), (x0 = e.clientX), (thumb.style.transition = 'none')));
      thumb.addEventListener('pointermove', (e) => x0 != null && (thumb.style.transform = `translateX(${Math.min(max(), Math.max(0, e.clientX - x0))}px)`));
      thumb.addEventListener('pointerup', (e) => {
        const dx = e.clientX - x0;
        x0 = null;
        thumb.style.transition = '';
        if (dx >= max() * 0.9) ctx.pay();
        else thumb.style.transform = '';
      });
    };
    return { el, phase };
  },
};

export const SHEETS = { A, B, C };
