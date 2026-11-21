import { plan, chunk } from './core.js';

// Secrets: DISCORD_WEBHOOK, optional DISCORD_USER_ID (to @ you), and one FEED_<NAME> per Canvas
// calendar feed URL (Canvas → Calendar → Calendar Feed). Adding a school = adding a FEED_ secret.

export default {
  async scheduled(_event, env) {
    await tick(env, Date.now());
  },
  async fetch() {
    return new Response('Not found', { status: 404 });
  },
};

async function tick(env, now) {
  if (!env.DISCORD_WEBHOOK) {
    console.log('DISCORD_WEBHOOK not set; skipping');
    return;
  }
  const feeds = Object.keys(env).filter((k) => k.startsWith('FEED_')).sort();
  const results = await Promise.all(feeds.map((k) => readFeed(k.slice(5), env[k])));
  for (const r of results) console.log(`feed ${r.name}: ${r.ok ? 'ok' : r.error}`);

  const raw = await env.STATE.get('state');
  const { state, messages } = plan(raw ? JSON.parse(raw) : {}, results, now);
  for (const m of messages) {
    if (await post(env, m.content, m.mention)) m.apply(state);
  }
  const next = JSON.stringify(state);
  if (next !== raw) await env.STATE.put('state', next);
}

async function readFeed(name, url) {
  try {
    // Canvas 403s any request without a User-Agent, and Workers' fetch doesn't send one.
    const res = await fetch(url, {
      headers: { 'user-agent': 'canvas-reminder/1.0 (+Cloudflare Worker)' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (!text.includes('BEGIN:VCALENDAR')) throw new Error('response is not an iCal feed');
    return { name, ok: true, text };
  } catch (e) {
    return { name, ok: false, error: e?.message ?? String(e) };
  }
}

async function post(env, content, mention) {
  const user = env.DISCORD_USER_ID;
  const body = mention && user ? `<@${user}> ${content}` : content;
  for (const part of chunk(body)) {
    const res = await fetch(env.DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: part,
        flags: 4, // suppress link previews
        allowed_mentions: user ? { users: [user] } : { parse: [] },
      }),
    });
    if (!res.ok) {
      console.log(`discord ${res.status}: ${await res.text()}`);
      return false;
    }
  }
  return true;
}
