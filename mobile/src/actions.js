// Assistant actions: the model is told (see ACTIONS_PROMPT) to emit fenced
// ```rtaction blocks with JSON when the user wants a calendar event, reminder,
// or email. We parse those out of the reply and render tappable cards.
// Everything here is deliberately defensive — model output is untrusted.

import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { LocalNotifications } from '@capacitor/local-notifications';

export function actionsPrompt() {
  const now = new Date();
  return [
    `Current date/time: ${now.toString()}.`,
    'You can hand the user real device actions. When the user asks to create a',
    'calendar event, set a reminder, or draft an email, include — in addition to',
    'your normal reply — one fenced code block per action, tagged rtaction, containing only JSON:',
    '```rtaction',
    '{"type":"event","title":"...","start":"YYYY-MM-DDTHH:mm","end":"YYYY-MM-DDTHH:mm","location":"...","description":"..."}',
    '```',
    '```rtaction',
    '{"type":"reminder","title":"...","at":"YYYY-MM-DDTHH:mm","notes":"..."}',
    '```',
    '```rtaction',
    '{"type":"email","to":"...","subject":"...","body":"..."}',
    '```',
    'Times are the user\'s local time. Omit unknown fields. Never invent email',
    'addresses. Only emit rtaction blocks when the user clearly wants the action.',
  ].join('\n');
}

// Split a model reply into displayable text + parsed actions.
export function parseActions(text) {
  const actions = [];
  const clean = (text || '').replace(/```rtaction\s*\n([\s\S]*?)```/g, (_, json) => {
    try {
      const a = JSON.parse(json);
      if (a && ['event', 'reminder', 'email'].includes(a.type)) actions.push(a);
    } catch {
      /* malformed block: leave it visible so the user sees something went wrong */
      return `\`\`\`\n${json}\`\`\``;
    }
    return '';
  });
  return { text: clean.trim(), actions };
}

// ---- calendar (.ics / vCalendar) --------------------------------------------

function pad(n) {
  return String(n).padStart(2, '0');
}

// Local wall-clock time, floating (no TZID) — lands at the right hour
// regardless of the device's zone database.
function icsDate(s) {
  const d = new Date(s);
  if (isNaN(d)) return null;
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
}

function icsEscape(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

export function buildIcs(ev) {
  const start = icsDate(ev.start);
  if (!start) throw new Error(`Event has no valid start time: ${ev.start}`);
  const end = icsDate(ev.end) || icsDate(new Date(new Date(ev.start).getTime() + 3600000).toISOString());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Roundtable Mobile//EN',
    'BEGIN:VEVENT',
    `UID:rt-${Date.now()}@roundtable`,
    `DTSTAMP:${icsDate(new Date().toISOString())}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${icsEscape(ev.title || 'Event')}`,
    ...(ev.location ? [`LOCATION:${icsEscape(ev.location)}`] : []),
    ...(ev.description ? [`DESCRIPTION:${icsEscape(ev.description)}`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.join('\r\n');
}

// Share sheet with a real .ics file — the user picks their calendar app.
export async function shareEventIcs(ev) {
  const ics = buildIcs(ev);
  const path = `rt-event-${Date.now()}.ics`;
  const { uri } = await Filesystem.writeFile({
    path,
    data: ics,
    directory: Directory.Cache,
    encoding: Encoding.UTF8,
  });
  await Share.share({ title: ev.title || 'Event', files: [uri] });
}

// One-tap Google Calendar prefill (works on Android via the gcal app/web).
export function googleCalendarUrl(ev) {
  const s = icsDate(ev.start);
  const e = icsDate(ev.end) || s;
  if (!s) return null;
  const q = new URLSearchParams({
    action: 'TEMPLATE',
    text: ev.title || 'Event',
    dates: `${s}/${e}`,
    ...(ev.location ? { location: ev.location } : {}),
    ...(ev.description ? { details: ev.description } : {}),
  });
  return `https://calendar.google.com/calendar/render?${q}`;
}

// ---- reminders (local notifications) ----------------------------------------

export async function scheduleReminder(rem) {
  const at = new Date(rem.at);
  if (isNaN(at)) throw new Error(`Reminder has no valid time: ${rem.at}`);
  if (at.getTime() <= Date.now()) throw new Error('That time is already in the past.');
  const perm = await LocalNotifications.requestPermissions();
  if (perm.display !== 'granted') throw new Error('Notification permission was denied.');
  await LocalNotifications.schedule({
    notifications: [
      {
        id: Math.floor(Date.now() % 2147483647),
        title: rem.title || 'Reminder',
        body: rem.notes || '',
        schedule: { at, allowWhileIdle: true },
      },
    ],
  });
  return at;
}

// ---- email -------------------------------------------------------------------

// mailto: — Capacitor routes non-http(s) schemes out to the OS, so this opens
// the user's mail app with everything prefilled.
export function emailUrl(em) {
  const q = new URLSearchParams({
    ...(em.subject ? { subject: em.subject } : {}),
    ...(em.body ? { body: em.body } : {}),
  });
  const qs = q.toString().replace(/\+/g, '%20'); // mailto wants %20, not +
  return `mailto:${encodeURIComponent(em.to || '')}${qs ? '?' + qs : ''}`;
}
