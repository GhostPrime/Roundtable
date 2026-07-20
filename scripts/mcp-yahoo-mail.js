#!/usr/bin/env node
// Yahoo Mail MCP server (stdio) for Roundtable.
//
// Read tools (annotations.readOnlyHint === true → run freely for any seat):
//   list_folders, list_messages, search_messages, read_message
// Write tools (no readOnlyHint → gated by canWrite + ActionApproval):
//   send_message, mark_read, move_message, delete_message
//
// Credentials come from env (Roundtable encrypts env values via safeStorage):
//   YAHOO_EMAIL         — full address, e.g. madhatvw@yahoo.com
//   YAHOO_APP_PASSWORD  — app password from Yahoo Account Security
//                         (NOT the normal account password)
//
// CommonJS on purpose — matches electron/, runs with plain `node`.

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');

const EMAIL = process.env.YAHOO_EMAIL;
const APP_PASSWORD = process.env.YAHOO_APP_PASSWORD;
const IMAP_HOST = 'imap.mail.yahoo.com';
const SMTP_HOST = 'smtp.mail.yahoo.com';
const MAX_BODY_CHARS = 10_000;

function assertCreds() {
  if (!EMAIL || !APP_PASSWORD) {
    throw new Error(
      'YAHOO_EMAIL and YAHOO_APP_PASSWORD env vars are required. ' +
      'Generate an app password at Yahoo Account Security → App passwords.'
    );
  }
}

// One connection per call — simple and robust; Yahoo drops idle IMAP anyway.
async function withImap(fn) {
  assertCreds();
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: 993,
    secure: true,
    auth: { user: EMAIL, pass: APP_PASSWORD },
    logger: false,
  });
  try {
    await client.connect();
  } catch (err) {
    if (err.authenticationFailed || /command failed|auth/i.test(err.message || '')) {
      throw new Error(
        `Yahoo rejected the login for ${EMAIL} (${err.responseText || err.message}). ` +
        'YAHOO_APP_PASSWORD must be a 16-character app password generated at ' +
        'Yahoo Account Security → App passwords — pasted without spaces. ' +
        'The normal account password will not work.'
      );
    }
    throw new Error(`IMAP connection to ${IMAP_HOST} failed: ${err.responseText || err.message}`);
  }
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => {});
  }
}

function fmtAddr(a) {
  if (!a) return '';
  const list = a.value || a;
  return (Array.isArray(list) ? list : [list])
    .map((x) => (x.name ? `${x.name} <${x.address}>` : x.address))
    .join(', ');
}

function envelopeLine(msg) {
  const env = msg.envelope || {};
  const from = (env.from || []).map((a) => a.name ? `${a.name} <${a.address}>` : a.address).join(', ');
  const flags = msg.flags ? [...msg.flags] : [];
  const unread = flags.includes('\\Seen') ? '' : ' [UNREAD]';
  const date = env.date ? new Date(env.date).toISOString().slice(0, 16).replace('T', ' ') : '';
  return `uid=${msg.uid}${unread} | ${date} | ${from} | ${env.subject || '(no subject)'}`;
}

function truncate(text, max = MAX_BODY_CHARS) {
  text = String(text || '').trim();
  return text.length > max
    ? `${text.slice(0, max)}\n\n…[truncated at ${max} of ${text.length} chars]`
    : text;
}

// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'list_folders',
    description: 'List all mail folders in the Yahoo account.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_messages',
    description: 'List the most recent messages in a folder (newest first). Returns uid, date, from, subject.',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Folder name (default "INBOX")' },
        limit: { type: 'number', description: 'Max messages, default 20, max 50' },
        unread_only: { type: 'boolean', description: 'Only unread messages' },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'search_messages',
    description: 'Search messages in a folder by text, sender, and/or date. Returns uid, date, from, subject.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search in message content/subject' },
        from: { type: 'string', description: 'Sender address or name contains' },
        since: { type: 'string', description: 'Only messages on/after this date (YYYY-MM-DD)' },
        folder: { type: 'string', description: 'Folder name (default "INBOX")' },
        limit: { type: 'number', description: 'Max results, default 20, max 50' },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'read_message',
    description: 'Read the full content of one message by uid.',
    inputSchema: {
      type: 'object',
      properties: {
        uid: { type: 'number', description: 'Message uid from list/search' },
        folder: { type: 'string', description: 'Folder name (default "INBOX")' },
      },
      required: ['uid'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'send_message',
    description: `Send an email from ${EMAIL || 'the configured Yahoo account'} via SMTP.`,
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient(s), comma-separated' },
        subject: { type: 'string' },
        body: { type: 'string', description: 'Plain-text body' },
        cc: { type: 'string', description: 'CC recipient(s), comma-separated' },
        bcc: { type: 'string', description: 'BCC recipient(s), comma-separated' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'mark_read',
    description: 'Mark a message read or unread by uid.',
    inputSchema: {
      type: 'object',
      properties: {
        uid: { type: 'number' },
        folder: { type: 'string', description: 'Folder name (default "INBOX")' },
        read: { type: 'boolean', description: 'true = mark read (default), false = mark unread' },
      },
      required: ['uid'],
    },
  },
  {
    name: 'move_message',
    description: 'Move a message to another folder by uid.',
    inputSchema: {
      type: 'object',
      properties: {
        uid: { type: 'number' },
        destination: { type: 'string', description: 'Destination folder name' },
        folder: { type: 'string', description: 'Source folder (default "INBOX")' },
      },
      required: ['uid', 'destination'],
    },
  },
  {
    name: 'delete_message',
    description: 'Move a message to the Trash folder by uid.',
    inputSchema: {
      type: 'object',
      properties: {
        uid: { type: 'number' },
        folder: { type: 'string', description: 'Source folder (default "INBOX")' },
      },
      required: ['uid'],
    },
    annotations: { destructiveHint: true },
  },
];

// ---------------------------------------------------------------------------

async function listFolders() {
  return withImap(async (client) => {
    const folders = await client.list();
    return folders.map((f) => f.path).sort().join('\n') || '(no folders)';
  });
}

async function listMessages({ folder = 'INBOX', limit = 20, unread_only = false }) {
  limit = Math.min(Math.max(1, Number(limit) || 20), 50);
  return withImap(async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      let uids;
      if (unread_only) {
        uids = await client.search({ seen: false }, { uid: true });
      } else {
        uids = await client.search({ all: true }, { uid: true });
      }
      if (!uids || !uids.length) return `No ${unread_only ? 'unread ' : ''}messages in ${folder}.`;
      uids = uids.sort((a, b) => b - a).slice(0, limit);
      const lines = [];
      for await (const msg of client.fetch(uids, { uid: true, envelope: true, flags: true }, { uid: true })) {
        lines.push(envelopeLine(msg));
      }
      lines.sort((a, b) => Number(b.match(/uid=(\d+)/)[1]) - Number(a.match(/uid=(\d+)/)[1]));
      return `${folder} — ${lines.length} message(s):\n${lines.join('\n')}`;
    } finally {
      lock.release();
    }
  });
}

async function searchMessages({ query, from, since, folder = 'INBOX', limit = 20 }) {
  limit = Math.min(Math.max(1, Number(limit) || 20), 50);
  const criteria = {};
  if (query) criteria.text = query;
  if (from) criteria.from = from;
  if (since) criteria.since = new Date(since);
  if (!Object.keys(criteria).length) criteria.all = true;
  return withImap(async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      let uids = await client.search(criteria, { uid: true });
      if (!uids || !uids.length) return `No matches in ${folder}.`;
      uids = uids.sort((a, b) => b - a).slice(0, limit);
      const lines = [];
      for await (const msg of client.fetch(uids, { uid: true, envelope: true, flags: true }, { uid: true })) {
        lines.push(envelopeLine(msg));
      }
      return `${folder} — ${lines.length} match(es):\n${lines.join('\n')}`;
    } finally {
      lock.release();
    }
  });
}

async function readMessage({ uid, folder = 'INBOX' }) {
  return withImap(async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg || !msg.source) return `No message with uid ${uid} in ${folder}.`;
      const parsed = await simpleParser(msg.source);
      const body = parsed.text || (parsed.html ? parsed.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') : '(empty body)');
      const atts = (parsed.attachments || []).map((a) => `${a.filename || 'unnamed'} (${a.contentType}, ${a.size} bytes)`);
      return [
        `From: ${fmtAddr(parsed.from)}`,
        `To: ${fmtAddr(parsed.to)}`,
        parsed.cc ? `Cc: ${fmtAddr(parsed.cc)}` : null,
        `Date: ${parsed.date ? parsed.date.toISOString() : '(unknown)'}`,
        `Subject: ${parsed.subject || '(no subject)'}`,
        atts.length ? `Attachments: ${atts.join('; ')}` : null,
        '',
        truncate(body),
      ].filter((l) => l !== null).join('\n');
    } finally {
      lock.release();
    }
  });
}

async function sendMessage({ to, subject, body, cc, bcc }) {
  assertCreds();
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: 465,
    secure: true,
    auth: { user: EMAIL, pass: APP_PASSWORD },
  });
  const info = await transporter.sendMail({ from: EMAIL, to, cc, bcc, subject, text: body });
  return `Sent. ${info.messageId || ''} → ${info.accepted?.join(', ') || to}`;
}

async function markRead({ uid, folder = 'INBOX', read = true }) {
  return withImap(async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const ok = read
        ? await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true })
        : await client.messageFlagsRemove(String(uid), ['\\Seen'], { uid: true });
      return ok ? `Marked uid ${uid} as ${read ? 'read' : 'unread'}.` : `Failed to update uid ${uid}.`;
    } finally {
      lock.release();
    }
  });
}

async function moveMessage({ uid, destination, folder = 'INBOX' }) {
  return withImap(async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const res = await client.messageMove(String(uid), destination, { uid: true });
      return res ? `Moved uid ${uid} from ${folder} to ${destination}.` : `Failed to move uid ${uid}.`;
    } finally {
      lock.release();
    }
  });
}

async function deleteMessage({ uid, folder = 'INBOX' }) {
  return withImap(async (client) => {
    // Find the Trash folder (Yahoo names it "Trash"; fall back to special-use flag).
    const folders = await client.list();
    const trash =
      folders.find((f) => f.specialUse === '\\Trash')?.path ||
      folders.find((f) => /^trash$/i.test(f.path))?.path || 'Trash';
    const lock = await client.getMailboxLock(folder);
    try {
      const res = await client.messageMove(String(uid), trash, { uid: true });
      return res ? `Moved uid ${uid} to ${trash}.` : `Failed to delete uid ${uid}.`;
    } finally {
      lock.release();
    }
  });
}

const HANDLERS = {
  list_folders: listFolders,
  list_messages: listMessages,
  search_messages: searchMessages,
  read_message: readMessage,
  send_message: sendMessage,
  mark_read: markRead,
  move_message: moveMessage,
  delete_message: deleteMessage,
};

// ---------------------------------------------------------------------------

async function main() {
  const server = new Server(
    { name: 'yahoo-mail', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const handler = HANDLERS[name];
    if (!handler) {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
    try {
      const text = await handler(args || {});
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err.message || String(err)}` }],
        isError: true,
      };
    }
  });

  await server.connect(new StdioServerTransport());
  // stderr only — stdout is the MCP transport.
  console.error(`yahoo-mail MCP server running (account: ${EMAIL || 'NOT CONFIGURED'})`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
