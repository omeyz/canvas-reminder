// Pure reminder logic: ICS text + previous state + clock in, Discord messages out.
// No I/O here so test/sim.mjs can replay real feeds against a fake clock.

export const TZ = 'America/Los_Angeles';
const HOUR = 3600e3;
const DAY = 24 * HOUR;

// Smallest-first. A reminder fires once per tier; reaching a smaller tier marks the larger ones done,
// so an assignment first seen 2h before it's due gets one "3h" ping, not a 24h and a 3h back to back.
const MIN = 60e3;
export const TIERS = [
  { id: '15m', ms: 15 * MIN, label: '🚨🚨🚨 **DUE IN 15 MINUTES** 🚨🚨🚨' },
  { id: '30m', ms: 30 * MIN, label: '🚨🚨 **DUE IN 30 MINUTES** 🚨🚨' },
  { id: '1h', ms: 1 * HOUR, label: '🚨 **DUE WITHIN 1 HOUR**' },
  { id: '2h', ms: 2 * HOUR, label: '⏰ **Due within 2 hours**' },
  { id: '3h', ms: 3 * HOUR, label: '⏰ **Due within 3 hours**' },
  { id: '6h', ms: 6 * HOUR, label: '⏰ **Due within 6 hours**' },
  { id: '12h', ms: 12 * HOUR, label: '⏰ **Due within 12 hours**' },
  { id: '24h', ms: 24 * HOUR, label: '⏰ **Due within 24 hours**' },
  { id: '48h', ms: 48 * HOUR, label: '📅 **Due within 2 days**' },
  { id: '72h', ms: 72 * HOUR, label: '📅 **Due within 3 days**' },
];
const DIGEST_HOURS = [8, 18];
const DIGEST_DAYS = 7;
const FEED_ALERT_AFTER = 2 * HOUR;

// ---------- ICS ----------

export function parseIcs(text) {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') cur = {};
    else if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; }
    else if (cur) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const [name, ...params] = line.slice(0, i).split(';');
      cur[name.toUpperCase()] = { value: line.slice(i + 1), params };
    }
  }
  return events;
}

const unescapeText = (v) => v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

function parseDue({ value }) {
  let m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (m) return Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  m = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  // Canvas exports anything due at 11:59 PM (user's zone) as an all-day event.
  if (m) return zonedToUtc(+m[1], +m[2], +m[3], 23, 59);
  m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (m) return zonedToUtc(+m[1], +m[2], +m[3], +m[4], +m[5]);
  return null;
}

// "COMP-162 Sec 001 - Computer Arch..." -> "COMP 162"; "MC.CS.M135.73313.73294" -> "CS M135"
function courseLabel(ctx) {
  let m = ctx.match(/^([A-Z]{2,5})-(\d{2,4}[A-Z]?)\b/);
  if (m) return `${m[1]} ${m[2]}`;
  m = ctx.match(/^[A-Z]{2}\.([A-Z]{2,5})\.([A-Z]?\d{2,4}[A-Z]?)\./);
  if (m) return `${m[1]} ${m[2]}`;
  return ctx;
}

// Feed URLs point at the calendar view; rebuild the direct assignment page.
function assignmentLink(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const course = u.searchParams.get('include_contexts')?.match(/^course_(\d+)$/);
    const asg = u.hash.match(/^#assignment_(\d+)$/);
    return course && asg ? `${u.origin}/courses/${course[1]}/assignments/${asg[1]}` : raw;
  } catch {
    return null;
  }
}

export function assignmentsFromIcs(feed, text) {
  return parseIcs(text)
    .filter((e) => e.UID?.value.startsWith('event-assignment-') && e.DTSTART)
    .map((e) => {
      const summary = unescapeText(e.SUMMARY?.value ?? '');
      const m = summary.match(/^(.*?)\s*\[([^\]]+)\]\s*$/);
      return {
        uid: `${feed}:${e.UID.value}`,
        title: (m ? m[1] : summary) || '(untitled)',
        course: courseLabel(m ? m[2] : feed),
        due: parseDue(e.DTSTART),
        url: assignmentLink(e.URL?.value),
      };
    })
    .filter((a) => a.due != null);
}

// ---------- time ----------

function zoneParts(ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(ms);
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}

function offsetAt(ms) {
  const p = zoneParts(ms);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

function zonedToUtc(y, mo, d, h, mi) {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  return wall - offsetAt(wall - offsetAt(wall));
}

const localDate = (ms) => { const p = zoneParts(ms); return `${p.year}-${p.month}-${p.day}`; };
const localHour = (ms) => +zoneParts(ms).hour;

const fmtDue = (ms) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(ms);

// ---------- messages ----------

const escapeMd = (s) => s.replace(/([\\*_~`|[\]])/g, '\\$1');

function line(a) {
  const title = a.url ? `[${escapeMd(a.title)}](<${a.url}>)` : escapeMd(a.title);
  return `**${a.course}** · ${title} — ${fmtDue(a.due)} (<t:${Math.floor(a.due / 1000)}:R>)`;
}

const byDue = (x, y) => x.due - y.due;

// Returns { state, messages }. The caller sends each message and calls message.apply(state)
// only if Discord accepted it, so a failed post is retried on the next tick.
export function plan(prev, results, now) {
  const s = structuredClone(prev ?? {});
  s.seen ??= {}; s.sent ??= {}; s.init ??= {}; s.fail ??= {}; s.cache ??= {};
  const messages = [];
  const all = [];
  const fresh = [];
  const moved = [];
  const blind = []; // failing feeds with no last good copy to fall back on

  for (const r of results) {
    if (r.ok) {
      if (s.fail[r.name]?.alerted) {
        messages.push({ content: `✅ The **${r.name}** Canvas feed is working again.`, apply: () => {} });
      }
      delete s.fail[r.name];
      const list = assignmentsFromIcs(r.name, r.text);
      const firstSync = !s.init[r.name];
      const live = new Set(list.map((a) => a.uid));
      for (const uid of Object.keys(s.seen)) if (uid.startsWith(`${r.name}:`) && !live.has(uid)) delete s.seen[uid];
      for (const a of list) {
        const before = s.seen[a.uid];
        if (firstSync || a.due <= now) s.seen[a.uid] = a.due;
        else if (before === undefined) fresh.push(a);
        else if (before !== a.due) moved.push({ a, before });
      }
      s.init[r.name] = true;
      s.cache[r.name] = list;
      all.push(...list);
    } else {
      // Keep reminding off the last good copy while the feed is down.
      if (s.cache[r.name]) all.push(...s.cache[r.name]);
      else blind.push(r.name);
      const f = (s.fail[r.name] ??= { since: now, alerted: false });
      if (!f.alerted && now - f.since >= FEED_ALERT_AFTER) {
        messages.push({
          content: `⚠️ Can't read the **${r.name}** Canvas feed (${r.error}) for ${Math.round((now - f.since) / HOUR)}h. ` +
            `Reminders are running off the last copy, so new assignments won't show up. ` +
            `If this keeps up, the feed link was probably reset in Canvas → Calendar → Calendar Feed.`,
          apply: (st) => { st.fail[r.name].alerted = true; },
        });
      }
    }
  }

  if (fresh.length || moved.length) {
    const rows = [
      ...fresh.sort(byDue).map((a) => `🆕 ${line(a)}`),
      ...moved.sort((x, y) => x.a.due - y.a.due).map(({ a, before }) => `📅 ${line(a)} *(was ${fmtDue(before)})*`),
    ];
    messages.push({
      content: `**Canvas update**\n${rows.join('\n')}`,
      apply: (st) => { for (const a of [...fresh, ...moved.map((x) => x.a)]) st.seen[a.uid] = a.due; },
    });
  }

  const upcoming = all.filter((a) => a.due > now).sort(byDue);

  const hits = new Map(TIERS.map((t) => [t.id, []]));
  const marks = [];
  for (const a of upcoming) {
    const idx = TIERS.findIndex((t) => a.due - now <= t.ms);
    if (idx < 0 || s.sent[`${a.uid}|${a.due}|${TIERS[idx].id}`]) continue;
    hits.get(TIERS[idx].id).push(a);
    for (const t of TIERS.slice(idx)) marks.push(`${a.uid}|${a.due}|${t.id}`);
  }
  const sections = TIERS.filter((t) => hits.get(t.id).length).map((t) => `${t.label}\n${hits.get(t.id).map(line).join('\n')}`);
  if (sections.length) {
    messages.push({ content: sections.join('\n\n'), mention: true, apply: (st) => { for (const k of marks) st.sent[k] ??= now; } });
  }

  // One digest per slot (morning, evening); a slot missed while Discord was down is caught up later.
  const hour = localHour(now);
  const slot = DIGEST_HOURS.filter((h) => hour >= h).pop();
  const today = slot === undefined ? null : `${localDate(now)}@${slot}`;
  if (today && s.digest !== today) {
    const week = upcoming.filter((a) => a.due <= now + DIGEST_DAYS * DAY);
    const gap = blind.length ? `\n⚠️ Couldn't read the ${blind.join(' and ')} Canvas feed, so it's missing from this list.` : '';
    messages.push({
      content: week.length
        ? `📚 **Due in the next ${DIGEST_DAYS} days**\n${week.map(line).join('\n')}${gap}`
        : blind.length
          ? `⚠️ Couldn't read the ${blind.join(' and ')} Canvas feed, so there's no digest to show today.`
          : `📚 Nothing due in the next ${DIGEST_DAYS} days.`,
      mention: week.length > 0 || blind.length > 0,
      apply: (st) => { st.digest = today; },
    });
  }

  // Forget reminder marks for assignments that are gone or two days past due.
  const known = new Map(all.map((a) => [a.uid, a.due]));
  for (const k of Object.keys(s.sent)) {
    const [uid] = k.split('|');
    if (!known.has(uid) || known.get(uid) < now - 2 * DAY) delete s.sent[k];
  }

  return { state: s, messages };
}

// Discord caps content at 2000 chars; split on line boundaries.
export function chunk(content, max = 1900) {
  const out = [];
  let cur = '';
  for (const l of content.split('\n')) {
    if (cur && cur.length + l.length + 1 > max) { out.push(cur); cur = ''; }
    cur = cur ? `${cur}\n${l}` : l;
  }
  if (cur) out.push(cur);
  return out;
}
