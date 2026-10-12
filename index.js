/**
 * discord-backdoor-bot/index.js — RFU Backdoor Intelligence Feed
 * Polls rareformu.io/data/alerts.json and posts intelligence briefings to Discord.
 *
 * Alert format v3: INSTITUTIONAL_POSITIONING | PREDICTION_SHIFT | MACRO_CONTEXT | SHADOW_KNOWLEDGE
 * Each alert: headline + before_the_move + the_truth + what_it_means + confidence + disclaimer
 */

require('dotenv').config();
const {verifyAlert,rpcFromEnv,reservePublication,evidenceMessage}=require('./alert-evidence.cjs');

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

// Supabase replaces the old static alerts.json — set SUPABASE_URL + SUPABASE_ANON_KEY in Railway
const SUPABASE_URL      = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const ALERTS_URL        = process.env.ALERTS_URL || 'https://rareformu.io/data/alerts.json';
const CHANNEL_ID        = process.env.DISCORD_CHANNEL_ID;
const POLL_INTERVAL     = 5 * 60 * 1000; // 5 minutes
const MAX_PER_POLL      = 5;              // cap burst posts per cycle

// ── Signal metadata ────────────────────────────────────────────────────────────
const SIGNAL_META = { ONCHAIN_ACTIVITY:{color:0xC9A84C,label:'On-chain activity'} };

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

// ── Fetch alerts — Supabase preferred, falls back to static URL ───────────────
function fetchAlerts() {
  if (SUPABASE_URL && SUPABASE_ANON_KEY) {
    return fetchFromSupabase();
  }
  return fetchFromUrl(ALERTS_URL);
}

function fetchFromSupabase() {
  const url = `${SUPABASE_URL}/rest/v1/rfu_alerts?select=payload&order=created_at.desc&limit=100`;
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      timeout: 15000,
    }, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          const rows = JSON.parse(data);
          // Supabase returns [{payload: {...}}, ...] — unwrap
          const alerts = Array.isArray(rows) ? rows.map(r => r.payload || r) : [];
          resolve(alerts);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('supabase timeout')); });
  });
}

function fetchFromUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000 }, res => {
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
            // No text retry: an ambiguous send failure must not publish a duplicate.
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
// HEADLINE → title | sections → fields | confidence + signal → footer
function buildEmbed(alert) {
  return new EmbedBuilder().setTitle('On-chain activity').setDescription(evidenceMessage(alert)).setFooter({text:'RareForm United'});
}

// ── Plain-text fallback ────────────────────────────────────────────────────────
function buildText(alert) { return evidenceMessage(alert); }

// ── Post a single alert ────────────────────────────────────────────────────────
async function postAlert(channel, alert) {
  const safe=await verifyAlert(alert,rpcFromEnv());
  if(!safe||!await reservePublication(safe,'discord:'+channel.id))return false;
  await channel.send({content:evidenceMessage(safe),allowedMentions:{parse:[]}});

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
