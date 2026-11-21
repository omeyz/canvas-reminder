// Replays saved Canvas feeds against a fake 15-minute cron clock and prints every Discord message.
// usage: node test/sim.mjs CSUCI=path/to/csuci.ics VCCCD=path/to/vcccd.ics [--from ISO] [--days N]
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { plan, assignmentsFromIcs } from '../src/core.js';

const args = process.argv.slice(2);
const feeds = Object.fromEntries(args.filter((a) => a.includes('=')).map((a) => {
  const [name, path] = a.split('=');
  return [name, readFileSync(path, 'utf8')];
}));
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const start = Date.parse(opt('--from', new Date().toISOString()));
const days = +opt('--days', 8);

// Date-only Canvas dues are 11:59 PM Pacific, on both sides of the Nov 1 DST change.
const allDay = (d) => `BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:event-assignment-1\nDTSTART;VALUE=DATE;VALUE=DATE:${d}\nSUMMARY:x [COMP-162 Sec 001 - y]\nEND:VEVENT\nEND:VCALENDAR`;
assert.equal(new Date(assignmentsFromIcs('T', allDay('20261015'))[0].due).toISOString(), '2026-10-16T06:59:00.000Z');
assert.equal(new Date(assignmentsFromIcs('T', allDay('20261105'))[0].due).toISOString(), '2026-11-06T07:59:00.000Z');

// A feed that has never loaded must not produce a "nothing due" digest.
const blindDigest = plan({}, [{ name: 'CSUCI', ok: false, error: 'HTTP 403' }], Date.parse('2026-10-12T16:00:00Z'))
  .messages.map((m) => m.content).join('\n');
assert.match(blindDigest, /Couldn't read the CSUCI/);
assert.doesNotMatch(blindDigest, /Nothing due/);

const fake = (uid, start, title) =>
  `BEGIN:VEVENT\r\nUID:event-assignment-${uid}\r\nDTSTART:${start}\r\nSUMMARY:${title} [MC.CS.M135.73313.73294]\r\n` +
  `URL;VALUE=URI:https://vcccd.instructure.com/calendar?include_contexts=course_91712&month=10&year=2026#assignment_${uid}\r\nEND:VEVENT\r\n`;

const fmt = (ms) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'medium', timeStyle: 'short' });
let state = {};
let sent = 0;
const tick = 15 * 60e3;
const t0 = Math.ceil(start / tick) * tick;
for (let now = t0; now < t0 + days * 864e5; now += tick) {
  const h = (now - t0) / 36e5;
  const results = Object.entries(feeds).map(([name, text]) => {
    // Hour 3-6: CSUCI feed is down. Hour 20+: a new VCCCD assignment appears. Hour 30+: its due date moves.
    if (name === 'CSUCI' && h >= 3 && h < 6) return { name, ok: false, error: 'HTTP 503' };
    if (name === 'VCCCD' && h >= 20) {
      const due = h >= 30 ? '20261017T060000Z' : '20261016T060000Z';
      text = text.replace('END:VCALENDAR', fake(9999999, due, 'Injected Test Assignment') + 'END:VCALENDAR');
    }
    return { name, ok: true, text };
  });
  const out = plan(state, results, now);
  state = out.state;
  for (const m of out.messages) {
    sent++;
    console.log(`\n=== ${fmt(now)}${m.mention ? '  [@mention]' : ''}\n${m.content}`);
    m.apply(state);
  }
}
console.log(`\n${sent} messages over ${days} days; final state ${JSON.stringify(state).length} bytes`);
