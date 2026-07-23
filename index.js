const express = require('express');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
const path = require('path');
const fs = require('fs');

// Register bundled fonts (Railway containers ship without system fonts)
try {
  GlobalFonts.registerFromPath(path.join(__dirname, 'DejaVuSans.ttf'), 'DejaVu Sans');
  GlobalFonts.registerFromPath(path.join(__dirname, 'DejaVuSans-Bold.ttf'), 'DejaVu Sans');
} catch (e) { console.error('font registration failed:', e); }

const app = express();
// Parse ALL bodies as raw text and JSON.parse manually with NaN sanitation —
// express.json() auto-400s on malformed JSON (e.g. Pine emitting NaN for
// young tickers with insufficient history), killing the whole chunk.
app.use(express.text({ type: '*/*', limit: '256kb' }));

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const DISCORD_WEBHOOK_URL_3M = process.env.DISCORD_WEBHOOK_URL_3M || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';

// 'D' → 1D; anything else is minutes ('3' → 3m)
const tfLabel = tf => (!tf || tf === 'D' ? '1D' : `${tf}m`);
const isDaily = d => !d.timeframe || d.timeframe === 'D';
// Route: daily entries → main channel; intraday → scalp channel (falls back to main if unset)
const webhookFor = d => (isDaily(d) ? DISCORD_WEBHOOK_URL : (DISCORD_WEBHOOK_URL_3M || DISCORD_WEBHOOK_URL));

// ── Snapshot cache ─────────────────────────────────────────────────────────
// ticker → { data: <same payload shape as an entry>, received_at: ISO string }
// Populated by daily snapshot_batch alerts AND by entry alerts.
// Persisted to /tmp so a same-container restart keeps it; a redeploy clears it
// (repopulates at the next daily alert).
const CACHE_FILE = '/tmp/snapshots.json';
const snapshots = new Map();
try {
  const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  for (const [t, v] of Object.entries(raw)) snapshots.set(t, v);
  console.log(`loaded ${snapshots.size} cached snapshots`);
} catch (_) { /* no cache yet */ }

function cacheSnapshot(d) {
  if (!d || !d.ticker) return;
  snapshots.set(String(d.ticker).toUpperCase(), {
    data: d,
    received_at: new Date().toISOString(),
  });
}
function persistCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(snapshots)));
  } catch (e) { console.error('cache persist failed:', e); }
}

// ── Dashboard renderer ─────────────────────────────────────────────────────
const C = {
  bg: '#0d0d15', headerBg: '#1a1a2e', rowBg: '#101018', border: '#3a3a4a',
  white: '#e8e8ee', teal: '#26a69a', orange: '#ff9800',
  bullBg: 'rgba(0,128,128,0.30)', bearBg: 'rgba(128,0,0,0.30)',
  warnBg: 'rgba(128,96,0,0.40)', green: '#00E676', blue: '#00BFFF',
  pinkish: '#FF69B4', red: '#FF5252', cyan: '#00FFFF', gray: '#888899',
};

const arrow = d => (d === 'up' ? '▲' : d === 'down' ? '▼' : '━');

function histStyle(state) {
  const pos = state.startsWith('POS');
  const up = state.includes('^');
  const label = (pos ? 'POS ' : 'NEG ') + (up ? '↑' : '↓');
  const color = pos ? (up ? C.green : C.blue) : (up ? C.pinkish : C.red);
  const bg = pos ? (up ? C.bullBg : C.warnBg) : (up ? C.warnBg : C.bearBg);
  return { label, color, bg };
}

function renderDashboard(d) {
  const W = 420, ROWS = 13, RH = 34, H = ROWS * RH;
  const cols = [0, 160, 310, W];
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  const cell = (col, row, txt, color = C.white, bg = null, bold = false, align = 'left') => {
    const x = cols[col], w = cols[col + 1] - x, y = row * RH;
    if (bg) { ctx.fillStyle = bg; ctx.fillRect(x, y, w, RH); }
    ctx.strokeStyle = C.border; ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, RH - 1);
    ctx.fillStyle = color;
    ctx.font = `${bold ? 'bold ' : ''}14px "DejaVu Sans", sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = align === 'center' ? 'center' : 'left';
    ctx.fillText(String(txt), align === 'center' ? x + w / 2 : x + 10, y + RH / 2);
  };
  // Title bar: ticker top-left, daily bar date top-right
  ctx.fillStyle = C.headerBg;
  ctx.fillRect(0, 0, W, RH);
  ctx.strokeStyle = C.border; ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, W - 1, RH - 1);
  ctx.textBaseline = 'middle';
  ctx.fillStyle = C.white;
  ctx.font = 'bold 15px "DejaVu Sans", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`${d.exchange ? d.exchange + ':' : ''}${d.ticker || ''} · ${tfLabel(d.timeframe)}`, 10, RH / 2);
  ctx.fillStyle = C.gray;
  ctx.font = '14px "DejaVu Sans", sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(String(d.bar_date || ''), W - 10, RH / 2);
  ctx.textAlign = 'left';
  for (let i = 0; i < 3; i++) cell(i, 1, ['INDICATOR', 'VALUE', 'STATE'][i], C.white, C.headerBg, true, i ? 'center' : 'left');
  const rsiRow = (row, name, val, dir, star) => {
    const v = Number(val);
    const color = v > 70 ? C.orange : v < 30 ? C.teal : C.white;
    const bg = v > 70 ? C.bearBg : v < 30 ? C.bullBg : null;
    cell(0, row, name + (star ? ' ★' : ''), C.white, C.rowBg);
    cell(1, row, val, color, C.rowBg, false, 'center');
    cell(2, row, arrow(dir), color, bg, false, 'center');
  };
  rsiRow(2, 'RSI 6', d.rsi6, d.rsi6_dir, false);
  rsiRow(3, 'RSI 14', d.rsi14, d.rsi14_dir, true);
  rsiRow(4, 'RSI 24', d.rsi24, d.rsi24_dir, false);
  const k = Number(d.stoch_k);
  const kc = k > 80 ? C.orange : k < 20 ? C.teal : C.white;
  const kb = k > 80 ? C.bearBg : k < 20 ? C.bullBg : null;
  cell(0, 5, 'StochRSI %K', C.white, C.rowBg);
  cell(1, 5, d.stoch_k, kc, C.rowBg, false, 'center');
  cell(2, 5, arrow(d.stoch_k_dir), kc, kb, false, 'center');
  const dv = Number(d.stoch_d);
  const dc = dv > 80 ? C.orange : dv < 20 ? C.teal : C.white;
  const bull = d.stoch_d_state === 'BULL ^';
  const bear = d.stoch_d_state === 'BEAR v';
  cell(0, 6, 'StochRSI %D', C.white, C.rowBg);
  cell(1, 6, d.stoch_d, dc, C.rowBg, false, 'center');
  cell(2, 6, bull ? 'BULL ▲' : bear ? 'BEAR ▼' : d.stoch_d,
       bull ? C.teal : bear ? C.orange : dc,
       bull ? C.bullBg : bear ? C.bearBg : null, false, 'center');
  const mc = d.macd_dir === 'up' ? C.teal : C.orange;
  cell(0, 7, 'MACD Line', C.white, C.rowBg);
  cell(1, 7, d.macd_line, mc, C.rowBg, false, 'center');
  cell(2, 7, arrow(d.macd_dir), mc, null, false, 'center');
  const hs = histStyle(String(d.macd_hist_state || 'NEG ^'));
  cell(0, 8, 'MACD Hist ★', C.white, C.rowBg);
  cell(1, 8, d.macd_hist, hs.color, C.rowBg, false, 'center');
  cell(2, 8, hs.label, hs.color, hs.bg, false, 'center');
  const vdPos = Number(d.vol_delta_k) > 0;
  cell(0, 9, 'Vol Delta', C.white, C.rowBg);
  cell(1, 9, d.vol_delta_k + 'K', vdPos ? C.teal : C.orange, C.rowBg, false, 'center');
  cell(2, 9, d.vol_state, vdPos ? C.teal : C.orange, vdPos ? C.bullBg : C.bearBg, false, 'center');
  // SIGNAL row — supports NONE (snapshot of a ticker with no active signal)
  const ultra = d.signal === 'ULTRA';
  const entry = d.signal === 'ENTRY';
  const sigTxt = ultra ? '★ ULTRA' : entry ? '▲ ENTRY' : '━ NONE';
  const sigColor = ultra ? C.cyan : entry ? C.blue : C.gray;
  const sigBg = (ultra || entry) ? C.bullBg : null;
  cell(0, 10, '── SIGNAL ──', C.white, C.headerBg, true);
  cell(1, 10, sigTxt, sigColor, sigBg, true, 'center');
  cell(2, 10, '', C.white, sigBg);
  const fp = Number(d.fib_pct);
  const fc = fp > 61.8 ? C.orange : fp < 38.2 ? C.teal : C.white;
  const fb = fp > 61.8 ? C.warnBg : fp < 38.2 ? C.bullBg : null;
  cell(0, 11, 'Fib Position', C.white, C.rowBg);
  cell(1, 11, d.fib_pct + '%', fc, C.rowBg, false, 'center');
  cell(2, 11, d.fib_zone, fc, fb, false, 'center');
  cell(0, 12, 'BUY RANGE', C.green, C.headerBg, true);
  cell(1, 12, `${d.buy_low} – ${d.buy_high}`, C.green, C.headerBg, true, 'center');
  cell(2, 12, '', C.gray, C.headerBg);
  return canvas.toBuffer('image/png');
}

function buildEmbed(d) {
  const ultra = d.signal === 'ULTRA';
  const entry = d.signal === 'ENTRY';
  return {
    title: `${ultra ? '★ ULTRA' : entry ? '▲ ENTRY' : '━ SNAPSHOT'} — ${d.ticker} [${tfLabel(d.timeframe)}]`,
    color: ultra ? 0x00ffff : entry ? 0x00bfff : 0x99aabb,
    description:
      `**Buy range:** \`${d.buy_low} – ${d.buy_high}\`\n` +
      `**Close:** \`${d.close}\`  •  **ATR14:** \`${d.atr14}\`\n` +
      `**Bar:** ${d.bar_date}`,
    image: { url: 'attachment://dashboard.png' },
    footer: { text: `TradeXWhisperer • ${d.exchange || ''}:${d.ticker}` },
    timestamp: new Date().toISOString(),
  };
}

async function postToDiscord(d, png) {
  const url = webhookFor(d);
  const username = isDaily(d) ? 'TEX-Entry' : 'TEX-Scalp';
  const form = new FormData();
  form.append('payload_json', JSON.stringify({ username, embeds: [buildEmbed(d)] }));
  form.append('files[0]', new Blob([png], { type: 'image/png' }), 'dashboard.png');
  const res = await fetch(url, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Discord ${res.status}: ${await res.text()}`);
}

// ── Compact snapshot decoding (snap_v2) ────────────────────────────────────
// Pine sends rows of positional arrays to fit ~20 tickers per alert, cutting
// the burst at daily close from ~16 webhooks to ~4 (rate-limit safe).
const DIR = { u: 'up', d: 'down', f: 'flat' };
const DSTATE = { B: 'BULL ^', X: 'BEAR v', '-': '--' };
const HSTATE = { 'P^': 'POS ^', 'Pv': 'POS v', 'N^': 'NEG ^', 'Nv': 'NEG v' };
const fibZone = p => p < 0 ? '< 0%' : p < 23.6 ? '0-23.6%' : p < 38.2 ? '23.6-38.2%' : p < 50 ? '38.2-50%' : p < 61.8 ? '50-61.8%' : p < 78.6 ? '61.8-78.6%' : p < 100 ? '78.6-100%' : '> 100%';

function expandRow(r, tf, barDate) {
  if (!Array.isArray(r) || r.length < 23) return null;
  const [ticker, exchange, sig, close, buyLo, atr14, r6, d6, r14, d14, r24, d24,
         k, dk, dV, dSt, m, dm, h, hSt, vdk, vSt, fibP] = r;
  if (close == null || ticker == null) return null;
  return {
    ticker, exchange: exchange || '', timeframe: tf, bar_date: barDate,
    signal: sig === 2 ? 'ULTRA' : sig === 1 ? 'ENTRY' : 'NONE',
    close, buy_low: buyLo, buy_high: close, atr14,
    rsi6: r6, rsi6_dir: DIR[d6] || 'flat',
    rsi14: r14, rsi14_dir: DIR[d14] || 'flat',
    rsi24: r24, rsi24_dir: DIR[d24] || 'flat',
    stoch_k: k, stoch_k_dir: DIR[dk] || 'flat',
    stoch_d: dV, stoch_d_state: DSTATE[dSt] || '--',
    macd_line: m, macd_dir: DIR[dm] || 'flat',
    macd_hist: h, macd_hist_state: HSTATE[hSt] || 'NEG ^',
    vol_delta_k: vdk, vol_state: vSt ? 'BUY PRES' : 'SELL PRES',
    fib_pct: fibP, fib_zone: fibZone(Number(fibP)),
  };
}

// ── HTTP endpoints ─────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.send('TradeXWhisperer relay is up'));

// Debug: which tickers are cached and how fresh they are
app.get('/snapshots', (_req, res) => {
  const out = {};
  for (const [t, v] of snapshots) out[t] = { bar_date: v.data.bar_date, signal: v.data.signal || 'NONE', received_at: v.received_at };
  res.json(out);
});

app.post('/webhook', async (req, res) => {
  try {
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
    // NaN (from Pine tickers with insufficient history) is invalid JSON — neutralize it
    const d = JSON.parse(raw.replace(/\bNaN\b/g, 'null'));
    if (WEBHOOK_SECRET && d.secret !== WEBHOOK_SECRET) {
      return res.status(401).send('bad secret');
    }

    // Compact daily snapshot batches (v2 format): cache only, no Discord post
    if (d.event === 'snap_v2' && Array.isArray(d.rows)) {
      let n = 0;
      for (const r of d.rows) {
        const s = expandRow(r, d.tf || 'D', d.bar_date || '');
        if (s && isDaily(s)) { cacheSnapshot(s); n++; }
      }
      persistCache();
      console.log(`Cached ${n}/${d.rows.length} snapshots (snap_v2, ${d.bar_date || '?'})`);
      return res.status(200).send('cached');
    }

    // Legacy verbose snapshot batches: cache only, no Discord post
    if (d.event === 'snapshot_batch' && Array.isArray(d.snapshots)) {
      for (const s of d.snapshots) if (isDaily(s)) cacheSnapshot(s); // !TICKER bot is daily-only
      persistCache();
      console.log(`Cached ${d.snapshots.length} snapshots (${d.snapshots.map(s => s.ticker).join(', ')})`);
      return res.status(200).send('cached');
    }

    const entries =
      d.event === 'entry_batch' && Array.isArray(d.entries) ? d.entries
      : d.event === 'entry_signal' ? [d]
      : null;
    if (!entries || entries.length === 0) return res.status(200).send('ignored');
    for (const e of entries) {
      if (isDaily(e)) cacheSnapshot(e); // daily entries also refresh the on-demand cache
      const png = renderDashboard(e);
      if (!webhookFor(e)) {
        const out = `/tmp/dashboard_${e.ticker || 'unknown'}.png`;
        fs.writeFileSync(out, png);
        console.log(`DRY RUN — PNG saved to ${out}`);
        continue;
      }
      await postToDiscord(e, png);
      console.log(`Posted ${e.signal} for ${e.ticker} (${e.bar_date})`);
      if (entries.length > 1) await new Promise(r => setTimeout(r, 500));
    }
    persistCache();
    res.status(200).send('ok');
  } catch (err) {
    console.error('webhook error:', err);
    res.status(500).send('error');
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`listening on :${port}`));

// ── Discord bot: on-demand snapshots via !TICKER ──────────────────────────
if (DISCORD_BOT_TOKEN) {
  const { Client, GatewayIntentBits, AttachmentBuilder } = require('discord.js');
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });

  client.once('ready', () => console.log(`Discord bot logged in as ${client.user.tag}`));

  client.on('messageCreate', async (msg) => {
    try {
      if (msg.author.bot) return;
      const m = msg.content.trim().match(/^!([A-Za-z][A-Za-z0-9.\-]{0,9})$/);
      if (!m) return;
      const cmd = m[1].toUpperCase();

      if (cmd === 'SNAPLIST' || cmd === 'LIST') {
        if (snapshots.size === 0) return void msg.reply('No snapshots cached yet — they load with the daily close alert.');
        const lines = [...snapshots.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([t, v]) => `\`${t}\` — ${v.data.signal || 'NONE'} (${v.data.bar_date})`);
        return void msg.reply(`**Cached snapshots (${snapshots.size}):**\n${lines.join('\n')}`.slice(0, 1900));
      }

      if (cmd === 'HELP') {
        return void msg.reply('`!TICKER` — 1D snapshot dashboard (e.g. `!SNDK`)\n`!snaplist` — tickers available\n`!help` — this message');
      }

      const hit = snapshots.get(cmd);
      if (!hit) {
        return void msg.reply(`No snapshot for \`${cmd}\`. It may not be in the screener watchlist, or today's snapshot hasn't fired yet. Try \`!snaplist\`.`);
      }

      const png = renderDashboard(hit.data);
      const embed = buildEmbed(hit.data);
      await msg.reply({
        embeds: [embed],
        files: [new AttachmentBuilder(png, { name: 'dashboard.png' })],
      });
      console.log(`!${cmd} answered for ${msg.author.tag}`);
    } catch (err) {
      console.error('bot command error:', err);
      try { await msg.reply('Something went wrong rendering that snapshot.'); } catch (_) {}
    }
  });

  client.login(DISCORD_BOT_TOKEN).catch(e => console.error('Discord login failed:', e));
} else {
  console.log('DISCORD_BOT_TOKEN not set — !TICKER bot disabled');
}
