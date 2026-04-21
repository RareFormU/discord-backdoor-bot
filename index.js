/**
 * discord-backdoor-bot/index.js — RFU Backdoor Intelligence Feed
 * Polls rareformu.io/data/alerts.json and posts intelligence briefings to Discord.
 *
 * Alert format v3: INSTITUTIONAL_POSITIONING | PREDICTION_SHIFT | MACRO_CONTEXT | SHADOW_KNOWLEDGE
 * Each alert: headline + before_the_move + the_truth + what_it_means + confidence + disclaimer
 */

require('dotenv').config();

const http = require('http');
http.createServer((req, res) => res.end('OK')).listen(process.env.PORT || 3000);

const { Client, GatewayIntentBits, EmbedBuilder, ActivityType } = require('discord.js');
const https = require('https');

const REQUIRED = ['DISCORD_BOT_TOKEN', 'DISCORD_CHANNEL_ID'];
const missing  = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
  console.error('❌ Missing env vars:', missing.join(', '));
  process.exit(1);
}

const ALERTS_URL     = process.env.ALERTS_URL || 'https://rareformu.io/data/alerts.json';
const CHANNEL_ID     = process.env.DISCORD_CHANNEL_ID;
const POLL_INTERVAL  = 5 * 60 * 1000; // 5 minutes
const MAX_PER_POLL   = 5;              // cap burst posts per cycle

// ── Signal metadata ────────────────────────────────────────────────────────────
const SIGNAL_META = {
  INSTITUTIONAL_POSITIONING: { emoji: '🏦', color: 0xC9A84C, label: 'Institutional Positioning' },
  PREDICTION_SHIFT:          { emoji: '📉', color: 0xFF3D6B, label: 'Prediction Market Shift'   },
  MACRO_CONTEXT:             { emoji: '🌐', color: 0x00FFC8, label: 'Macro Intelligence'         },
  SHADOW_KNOWLEDGE:          { emoji: '👁',  color: 0xFFB830, label: 'Shadow Knowledge Alert'    },
};

const DEFAULT_META = { emoji: '🔍', color: 0x888888, label: 'Intelligence Signal' };

// ── Alert deduplication ────────────────────────────────────────────────────────
const seenIds = new Set();

// ── Discord client ─────────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once('ready', () => {
  console.log(`✅ RFU Intelligence Feed online — ${client.user.tag}`);
  client.user.setActivity('The Board', { type: ActivityType.Watching });
  setTimeout(poll, 10_000);
  setInterval(poll, POLL_INTERVAL);
});

// ── Fetch alerts from CDN ──────────────────────────────────────────────────────
function fetchAlerts() {
  return new Promise((resolve, reject) => {
    const req = https.get(ALERTS_URL, { timeout: 15000 }, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(Array.isArray(json) ? json : json.alerts || []);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── Main poll loop ─────────────────────────────────────────────────────────────
let polling = false;

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const alerts = await fetchAlerts();
    const newAlerts = alerts.filter(a => {
      const id = a.alert_id || a.id || `${a.timestamp}_${a.signal_type}`;
      if (seenIds.has(id)) return false;
      seenIds.add(id);
      return true;
    });

    if (seenIds.size > 5000) {
      const arr = [...seenIds];
      seenIds.clear();
      arr.slice(-2500).forEach(id => seenIds.add(id));
    }

    if (newAlerts.length === 0) {
      console.log(`[poll] No new alerts — ${alerts.length} total in feed`);
      return;
    }

    const toPost = newAlerts.slice(0, MAX_PER_POLL);
    console.log(`[poll] ${newAlerts.length} new alerts — posting ${toPost.length}`);

    const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
    if (!channel) {
      console.error('[poll] Channel not found:', CHANNEL_ID);
      return;
    }

    for (const alert of toPost) {
      try {
        await postAlert(channel, alert);
        await new Promise(r => setTimeout(r, 1500));
      } catch (err) {
        if (err.code === 50013 || err.message?.includes('Missing Permissions')) {
          console.warn('[poll] Missing permissions — falling back to text');
          try {
            await channel.send(buildText(alert));
          } catch (textErr) {
            console.error('[poll] Text fallback failed:', textErr.message);
          }
        } else {
          console.error('[poll] Post error:', err.message);
        }
      }
    }

  } catch (err) {
    console.error('[poll] Fetch error:', err.message);
  } finally {
    polling = false;
  }
}

// ── Build Discord embed (v3 intelligence format) ───────────────────────────────
function buildEmbed(alert) {
  const signal = alert.signal_type || 'UNKNOWN';
  const meta   = SIGNAL_META[signal] || DEFAULT_META;

  const conf    = alert.confidence || 0;
  const confPct = Math.round(conf * 100);
  const confBar = '█'.repeat(Math.floor(confPct / 10)) + '░'.repeat(10 - Math.floor(confPct / 10));

  const asset      = alert.asset ? ` — ${alert.asset}` : '';
  const disclaimer = alert.disclaimer || 'This is truth and knowledge, not investment advice.';

  const embed = new EmbedBuilder()
    .setColor(meta.color)
    .setTitle(`${meta.emoji} ${meta.label}${asset}`)
    .setDescription(`**${alert.headline || 'Intelligence Signal'}**`)
    .setFooter({ text: 'RareForm United — Backdoor Vision · rareformu.io/#backdoor' })
    .setTimestamp(alert.timestamp ? new Date(alert.timestamp) : new Date());

  if (alert.before_the_move) {
    embed.addFields({
      name:   '📍 BEFORE THE MOVE',
      value:  alert.before_the_move.slice(0, 1000),
      inline: false,
    });
  }

  if (alert.the_truth) {
    embed.addFields({
      name:   '🔎 THE TRUTH',
      value:  alert.the_truth.slice(0, 1000),
      inline: false,
    });
  }

  if (alert.what_it_means) {
    embed.addFields({
      name:   '⚡ WHAT IT MEANS',
      value:  alert.what_it_means.slice(0, 1000),
      inline: false,
    });
  }

  embed.addFields(
    { name: 'CONFIDENCE', value: `${confPct}%  \`${confBar}\``, inline: true },
    { name: 'SIGNAL',     value: `\`${signal}\``,               inline: true },
  );

  const src = alert.source_data || {};
  if (src.platform) {
    embed.addFields({ name: 'PLATFORM', value: src.platform, inline: true });
  }
  if (src.url) {
    embed.addFields({ name: 'SOURCE', value: src.url.slice(0, 200), inline: false });
  }

  embed.addFields({
    name:   '⚠️ DISCLAIMER',
    value:  `*${disclaimer}*`,
    inline: false,
  });

  return embed;
}

// ── Plain-text fallback ────────────────────────────────────────────────────────
function buildText(alert) {
  const signal  = alert.signal_type || 'INTELLIGENCE SIGNAL';
  const meta    = SIGNAL_META[signal] || DEFAULT_META;
  const conf    = Math.round((alert.confidence || 0) * 100);
  const asset   = alert.asset ? ` [${alert.asset}]` : '';

  const lines = [
    `${meta.emoji} **${meta.label}${asset}**`,
    `> **${alert.headline || 'Intelligence Signal'}**`,
    ``,
  ];

  if (alert.before_the_move) {
    lines.push(`**📍 BEFORE THE MOVE**\n${alert.before_the_move.slice(0, 500)}`);
    lines.push('');
  }
  if (alert.the_truth) {
    lines.push(`**🔎 THE TRUTH**\n${alert.the_truth.slice(0, 500)}`);
    lines.push('');
  }
  if (alert.what_it_means) {
    lines.push(`**⚡ WHAT IT MEANS**\n${alert.what_it_means.slice(0, 500)}`);
    lines.push('');
  }

  lines.push(`**CONFIDENCE:** ${conf}%`);

  const src = alert.source_data || {};
  if (src.url) lines.push(`**SOURCE:** <${src.url}>`);

  lines.push(`-# ${alert.disclaimer || 'This is truth and knowledge, not investment advice.'}`);
  lines.push(`-# RareForm United — Backdoor Vision · rareformu.io`);

  return lines.join('\n');
}

// ── Post a single alert ────────────────────────────────────────────────────────
async function postAlert(channel, alert) {
  const embed = buildEmbed(alert);
  await channel.send({ embeds: [embed] });

  const signal = alert.signal_type || 'UNKNOWN';
  const conf   = Math.round((alert.confidence || 0) * 100);
  console.log(`[post] ${signal} conf=${conf}% — ${(alert.headline || '').slice(0, 60)}`);
}

// ── Error handlers ─────────────────────────────────────────────────────────────
client.on('error', err => console.error('[discord] Error:', err.message));
process.on('unhandledRejection', r  => console.error('[unhandledRejection]', r?.message || r));
process.on('uncaughtException', err => console.error('[uncaughtException]', err.message));

// ── Login with retry ───────────────────────────────────────────────────────────
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
