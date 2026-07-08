const express = require('express');
const { createCanvas } = require('@napi-rs/canvas');

const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.text({ type: '*/*', limit: '64kb' }));

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

const C = {
  bg: '#0d0d15', headerBg: '#1a1a2e', rowBg: '#101018', border: '#3a3a4a',
  white: '#e8e8ee', teal: '#26a69a', orange: '#ff9800',
  bullBg: 'rgba(0,128,128,0.30)', bearBg: 'rgba(128,0,0,0.30)',
  warnBg: 'rgba(128,96,0,0.40)', green: '#00E676', blue: '#00BFFF',
  pinkish: '#FF69B4', red: '#FF5252', cyan: '#00FFFF',
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
  const W = 420, ROWS = 12, RH = 34, H = ROWS * RH;
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
  for (let i = 0; i < 3; i++) cell(i, 0, ['INDICATOR', 'VALUE', 'STATE'][i], C.white, C.headerBg, true, i ? 'center' : 'left');
  const rsiRow = (row, name, val, dir, star) => {
    const v = Number(val);
    const color = v > 70 ? C.orange : v < 30 ? C.teal : C.white;
    const bg = v > 70 ? C.bearBg : v < 30 ? C.bullBg : null;
    cell(0, row, name + (star ? ' ★' : ''), C.white, C.rowBg);
    cell(1, row, val, color, C.rowBg, false, 'center');
    cell(2, row, arrow(dir), color, bg, false, 'center');
  };
  rsiRow(1, 'RSI 6', d.rsi6, d.rsi6_dir, false);
  rsiRow(2, 'RSI 14', d.rsi14, d.rsi14_dir, true);
  rsiRow(3, 'RSI 24', d.rsi24, d.rsi24_dir, false);
  const k = Number(d.stoch_k);
  const kc = k > 80 ? C.orange : k < 20 ? C.teal : C.white;
  const kb = k > 80 ? C.bearBg : k < 20 ? C.bullBg : null;
  cell(0, 4, 'StochRSI %K', C.white, C.rowBg);
  cell(1, 4, d.stoch_k, kc, C.rowBg, false, 'center');
  cell(2, 4, arrow(d.stoch_k_dir), kc, kb, false, 'center');
  const dv = Number(d.stoch_d);
  const dc = dv > 80 ? C.orange : dv < 20 ? C.teal : C.white;
  const bull = d.stoch_d_state === 'BULL ^';
  const bear = d.stoch_d_state === 'BEAR v';
  cell(0, 5, 'StochRSI %D', C.white, C.rowBg);
  cell(1, 5, d.stoch_d, dc, C.rowBg, false, 'center');
  cell(2, 5, bull ? 'BULL ▲' : bear ? 'BEAR ▼' : d.stoch_d,
       bull ? C.teal : bear ? C.orange : dc,
       bull ? C.bullBg : bear ? C.bearBg : null, false, 'center');
  const mc = d.macd_dir === 'up' ? C.teal : C.orange;
  cell(0, 6, 'MACD Line', C.white, C.rowBg);
  cell(1, 6, d.macd_line, mc, C.rowBg, false, 'center');
  cell(2, 6, arrow(d.macd_dir), mc, null, false, 'center');
  const hs = histStyle(String(d.macd_hist_state || 'NEG ^'));
  cell(0, 7, 'MACD Hist ★', C.white, C.rowBg);
  cell(1, 7, d.macd_hist, hs.color, C.rowBg, false, 'center');
  cell(2, 7, hs.label, hs.color, hs.bg, false, 'center');
  const vdPos = Number(d.vol_delta_k) > 0;
  cell(0, 8, 'Vol Delta', C.white, C.rowBg);
  cell(1, 8, d.vol_delta_k + 'K', vdPos ? C.teal : C.orange, C.rowBg, false, 'center');
  cell(2, 8, d.vol_state, vdPos ? C.teal : C.orange, vdPos ? C.bullBg : C.bearBg, false, 'center');
  const ultra = d.signal === 'ULTRA';
  cell(0, 9, '── SIGNAL ──', C.white, C.headerBg, true);
  cell(1, 9, (ultra ? '★ ULTRA' : '▲ ENTRY'), ultra ? C.cyan : C.blue, C.bullBg, true, 'center');
  cell(2, 9, '', C.white, C.bullBg);
  const fp = Number(d.fib_pct);
  const fc = fp > 61.8 ? C.orange : fp < 38.2 ? C.teal : C.white;
  const fb = fp > 61.8 ? C.warnBg : fp < 38.2 ? C.bullBg : null;
  cell(0, 10, 'Fib Position', C.white, C.rowBg);
  cell(1, 10, d.fib_pct + '%', fc, C.rowBg, false, 'center');
  cell(2, 10, d.fib_zone, fc, fb, false, 'center');
  cell(0, 11, 'BUY RANGE', C.green, C.headerBg, true);
  cell(1, 11, `${d.buy_low} – ${d.buy_high}`, C.green, C.headerBg, true, 'center');
  cell(2, 11, d.bar_date || '', '#888899', C.headerBg, false, 'center');
  return canvas.toBuffer('image/png');
}

async function postToDiscord(d, png) {
  const ultra = d.signal === 'ULTRA';
  const embed = {
    title: `${ultra ? '★ ULTRA' : '▲ ENTRY'} — ${d.ticker}`,
    color: ultra ? 0x00ffff : 0x00bfff,
    description:
      `**Buy range:** \`${d.buy_low} – ${d.buy_high}\`\n` +
      `**Close:** \`${d.close}\`  •  **ATR14:** \`${d.atr14}\`\n` +
      `**Daily bar:** ${d.bar_date}`,
    image: { url: 'attachment://dashboard.png' },
    footer: { text: `TradeXWhisperer • ${d.exchange || ''}:${d.ticker}` },
    timestamp: new Date().toISOString(),
  };
  const form = new FormData();
  form.append('payload_json', JSON.stringify({ username: 'TradeXWhisperer', embeds: [embed] }));
  form.append('files[0]', new Blob([png], { type: 'image/png' }), 'dashboard.png');
  const res = await fetch(DISCORD_WEBHOOK_URL, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Discord ${res.status}: ${await res.text()}`);
}

app.get('/', (_req, res) => res.send('TradeXWhisperer relay is up'));

app.post('/webhook', async (req, res) => {
  try {
    const d = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (WEBHOOK_SECRET && d.secret !== WEBHOOK_SECRET) {
      return res.status(401).send('bad secret');
    }
    const entries =
      d.event === 'entry_batch' && Array.isArray(d.entries) ? d.entries
      : d.event === 'entry_signal' ? [d]
      : null;
    if (!entries || entries.length === 0) return res.status(200).send('ignored');
    for (const e of entries) {
      const png = renderDashboard(e);
      if (!DISCORD_WEBHOOK_URL) {
        const out = `/tmp/dashboard_${e.ticker || 'unknown'}.png`;
        require('fs').writeFileSync(out, png);
        console.log(`DRY RUN — PNG saved to ${out}`);
        continue;
      }
      await postToDiscord(e, png);
      console.log(`Posted ${e.signal} for ${e.ticker} (${e.bar_date})`);
      if (entries.length > 1) await new Promise(r => setTimeout(r, 500));
    }
    res.status(200).send('ok');
  } catch (err) {
    console.error('webhook error:', err);
    res.status(500).send('error');
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`listening on :${port}`));
