# Yahoo Mail MCP — setup

## 1. Get a Yahoo app password
Yahoo blocks normal passwords for IMAP/SMTP clients.
login.yahoo.com → Account Security → **App passwords** → Generate (name it "Roundtable"). Copy the 16-char password.

## 2. Register in Roundtable (MCP settings)
- **Name:** `Yahoo Mail` (slug becomes `yahoo-mail`)
- **Transport:** stdio
- **Command:** `node`
- **Args:** absolute path to `scripts/mcp-yahoo-mail.js` in this repo
- **Env:**
  - `YAHOO_EMAIL` = madhatvw@yahoo.com
  - `YAHOO_APP_PASSWORD` = the app password (encrypted via safeStorage like API keys)

## 3. Tools
Read (free for any seat): `list_folders`, `list_messages`, `search_messages`, `read_message`
Write (canWrite + ActionApproval): `send_message`, `mark_read`, `move_message`, `delete_message` (moves to Trash)

Seat usage example:
```
CHECK: mcp yahoo-mail.search_messages {"query": "invoice", "since": "2026-07-01"}
```

Deps added to package.json: `imapflow`, `nodemailer`, `mailparser` (all pure JS).
