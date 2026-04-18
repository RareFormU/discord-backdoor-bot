/**
 * discord-backdoor-bot/index.js — RFU Backdoor Vision Alert Bot
 * Polls rareformu.io/data/alerts.json every 5 minutes.
 * Posts new alerts to #whale-alerts with black/gold embed styling.
 */

require('dotenv').config();

const http = require('http');
http.createServer((req, res) => res.end('OK')).listen(process.env.PORT || 3000);

const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

const REQUIRED = ['DISCORD_BOT_TOKEN', 'DISCORD_CHANNEL_ID'];
const missing  = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
  console.error('❌ Missing env vars:', missing.join(', '));
  process.exit(1);
}

const ALERTS_URL    = process.env.ALERTS_URL || 'https://rareformu.io/data/alerts.json';
const CHANNEL_ID    = process.env.DISCORD_CHANNEL_ID;
const POLL_INTERVAL = 5 * 60 * 1000; // 5 minutes

// ── Signal type display config ────────────────────────────────────────────────
const SIGNAL = {
  WHALE_SIGNATURE:        { color: 0xC9A84C, emoji: '🐋', label: 'Whale Signature'        },
  BURNER_INTEL:           { color: 0xFF6B35, emoji: '🔥', label: 'Burner Intel'             },
  ORACLE_FRONT_RUNNER:    { color: 0x00FFC8, emoji: '⚡', label: 'Oracle Front-Runner'      },
  INFORMED_MANIPULATION:  { color: 0xFF4444, emoji: '🎯', label: 'Informed Manipulation'    },
  SHADOW_CLUSTER:         { color: 0x9B59B6, emoji: '🕸',  label: 'Shadow Cluster'          },
  CLUSTER_MAP:            { color: 0xC9A84C, emoji: '🗺',  label: 'Cluster Map'             },
  DIVERGENCE_ALERT:       { color: 0x3498DB, emoji: '📊', label: 'Divergence Alert'         },
};

// ── Alert deduplication (in-memory, resets on restart) ────────────────────────
const seenIds = new Set();
const SEEN_MAX = 5000;
function addSeen(id) {
  seenIds.add(id);
  if (seenIds.size > SEEN_MAX) seenIds.delete(seenIds.values().next().value);
}

// ── Format helpers ────────────────────────────────────────────────────────────
function shortWallet(addr) {
  if (!addr || addr === '—') return '—';
  return `\`${addr.slice(0, 6)}…${addr.slice(-6)}\``;
}

function usdStr(n) {
  if (!n && n !== 0) return '—';
  return `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function confBar(conf) {
  const pct  = Math.round((conf || 0) * 100);
  const fill  = Math.round(pct / 10);
  const empty = 10 - fill;
  return `${'█'.repeat(fill)}${'░'.repeat(empty)} ${pct}%`;
}

// ── Build embed from any alert shape ─────────────────────────────────────────
function buildEmbed(alert) {
  const sig = SIGNAL[alert.signal_type] || { color: 0xC9A84C, emoji: '◈', label: alert.signal_type || 'Signal' };

  // Wallet — varies by detector
  const wallet = alert.wallet_address
    || alert.shadow_actor?.primary_wallet
    || (Array.isArray(alert.wallets) ? alert.wallets[0] : null)
    || null;

  // Market label
  const marketRaw = typeof alert.market === 'string'
    ? alert.market
    : alert.market?.question || alert.market?.contract || '';
  const market = marketRaw.length > 90 ? marketRaw.slice(0, 87) + '…' : (marketRaw || '—');

  // Position USD
  const posUsd = alert.position_size
    || alert.market?.position_size_usd
    || alert.cluster_position_usd
    || null;

  // Funding source (Burner Intel)
  const funding = alert.shadow_actor?.funding_source || null;

  // Gray window ms (Oracle Front-Runner)
  const grayMs = alert.evidence?.gray_window_ms || null;

  const fields = [
    { name: 'Wallet',     value: shortWallet(wallet),        inline: true  },
    { name: 'Confidence', value: confBar(alert.confidence),  inline: false },
    { name: 'Position',   value: usdStr(posUsd),             inline: true  },
    { name: 'Market',     value: market,                     inline: false },
  ];

  if (funding) fields.push({ name: 'Funding Source', value: `\`${funding}\``, inline: true });
  if (grayMs)  fields.push({ name: 'Gray Window',    value: `${grayMs.toLocaleString()}ms`, inline: true });

  const embed = new EmbedBuilder()
    .setColor(sig.color)
    .setTitle(`${sig.emoji}  ${sig.label}`)
    .setDescription(`\`\`\`\n${alert.rfu_tag || 'SIGNAL_DETECTED'}\n\`\`\``)
    .addFields(fields)
    .setFooter({ text: 'RareForm United — Backdoor Vision  ·  rareformu.io' })
    .setTimestamp(alert.timestamp ? new Date(alert.timestamp) : new Date());

  return embed;
}

// ── Plain-text fallback (EMBED_LINKS denied) ──────────────────────────────────
function buildText(alert) {
  const sig    = SIGNAL[alert.signal_type] || { emoji: '◈', label: alert.signal_type };
  const wallet = alert.wallet_address || alert.shadow_actor?.primary_wallet || '—';
  const market = (typeof alert.market === 'string' ? alert.market : alert.market?.question || '—').slice(0, 80);
  const conf   = alert.confidence ? `${Math.round(alert.confidence * 100)}%` : '—';
  return [
    `${sig.emoji} **${sig.label}** — \`${alert.rfu_tag || 'SIGNAL'}\``,
    `**Wallet:** ${wallet !== '—' ? `\`${wallet.slice(0,6)}…${wallet.slice(-6)}\`` : '—'}`,
    `**Confidence:** ${conf}  |  **Market:** ${market}`,
    `-# RareForm United — Backdoor Vision`,
  ].join('\n');
}

// ── Fetch alerts.json ─────────────────────────────────────────────────────────
async function fetchAlerts() {
  const res = await fetch(ALERTS_URL, {
    headers: { 'Cache-Control': 'no-cache', 'User-Agent': 'RFU-BackdoorBot/1.0' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.alerts) ? data.alerts : [];
}

// ── Poll and post ─────────────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
let pollRunning = false;

async function poll() {
  if (pollRunning) { console.log('[poll] Previous poll still running — skipping'); return; }
  pollRunning = true;
  console.log(`[poll] Polling at ${new Date().toISOString()}`);

  try {
    const alerts = await fetchAlerts();
    console.log(`[poll] Fetched ${alerts.length} alerts from CDN`);

    if (!client.isReady()) { console.warn('[poll] Client not ready'); return; }

    const channel = await client.channels.fetch(CHANNEL_ID).catch(err => {
      console.error('[poll] Cannot fetch channel:', err.message);
      return null;
    });
    if (!channel?.isTextBased()) { console.error('[poll] Channel not text-based'); return; }

    // New alerts only, cap burst at 10, post oldest-first
    const fresh = alerts
      .filter(a => a.alert_id && !seenIds.has(a.alert_id))
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
      .slice(-10);

    if (!fresh.length) { console.log('[poll] No new alerts'); return; }
    console.log(`[poll] Posting ${fresh.length} new alert(s)`);

    for (const alert of fresh) {
      try {
        await channel.send({ embeds: [buildEmbed(alert)] });
        console.log(`[poll] ✓ ${alert.signal_type} conf=${alert.confidence} rfu_tag=${alert.rfu_tag}`);
      } catch (embedErr) {
        if (embedErr.code === 50013 || embedErr.message?.includes('Missing Permissions')) {
          console.warn('[poll] EMBED_LINKS denied — falling back to text');
          try {
            await channel.send(buildText(alert));
            console.log(`[poll] ✓ (text) ${alert.signal_type}`);
          } catch (textErr) {
            console.error('[poll] Text fallback failed:', textErr.message);
          }
        } else {
          console.error('[poll] Send failed:', embedErr.message);
        }
      }
      addSeen(alert.alert_id);
      await new Promise(r => setTimeout(r, 1200));
    }
  } catch (err) {
    console.error('[poll] Error:', err.message);
  } finally {
    pollRunning = false;
  }
}

// ── Discord events ────────────────────────────────────────────────────────────
client.once('clientReady', () => {
  console.log(`✅ RFU Backdoor online — ${client.user.tag}`);
  setTimeout(poll, 10_000);
  setInterval(poll, POLL_INTERVAL);
});

client.on('error', err => console.error('[discord] Error:', err.message));

process.on('unhandledRejection', r  => console.error('[unhandledRejection]', r?.message || r));
process.on('uncaughtException',  err => console.error('[uncaughtException]', err.message));

// ── Login with retry ──────────────────────────────────────────────────────────
async function login(attempt = 0) {
  try {
    await client.login(process.env.DISCORD_BOT_TOKEN);
  } catch (err) {
    console.error(`[login] Attempt ${attempt + 1} failed:`, err.message);
    if (err.message.includes('TOKEN_INVALID') || err.message.includes('Improper token')) {
      console.error('[login] Token invalid — set DISCORD_BOT_TOKEN in Railway Variables.');
      process.exit(1);
    }
    if (attempt < 5) {
      const delay = (attempt + 1) * 5000;
      console.log(`[login] Retrying in ${delay / 1000}s…`);
      await new Promise(r => setTimeout(r, delay));
      return login(attempt + 1);
    }
    process.exit(1);
  }
}

login();
