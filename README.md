# XEvents Telegram bot

A private-chat event planner for @XEvents_bot. Requires Node.js 22 or newer; no packages to install.

## Cloudflare deployment

Deployed to `https://YOUR_WORKER_SUBDOMAIN.workers.dev` with Telegram webhook `/telegram` and Cloudflare D1 database `xevents`. Use the bot directly at https://t.me/XEvents_bot; your computer does not need to remain on.

Cloudflare stores `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` as Worker secrets. Incoming webhook requests require Telegram's secret header. Database leases serialize updates and message delivery; duplicate updates are ignored for seven days. State and outgoing messages commit in one D1 transaction before delivery. Failed deliveries retry through a durable outbox and a one-minute cron. Replies may duplicate if execution stops after Telegram accepts a message but before the outbox is cleared.

Run `npm ci`, `npm test`, and `npm run test:worker` to verify. Update with `npx wrangler d1 migrations apply xevents --remote`, then `npm run deploy`. Do not run the local polling process against the deployed bot: it removes the webhook. After rotating the token with BotFather, update `TELEGRAM_BOT_TOKEN` using `npx wrangler secret put TELEGRAM_BOT_TOKEN`.

The protected `/setup` POST route verifies bot identity before registering the webhook and commands. Public `/` exposes health only. Integration tests mock Telegram and check authentication, event creation, D1 persistence, and duplicate handling. Live verification confirmed health, unauthorized webhook rejection, and Telegram webhook registration.

This initial deployment loads event/session records per update and serializes writes. It is intended for a small community; larger usage should move to indexed per-event reads. Media lives on Telegram, with file references stored in D1.

## Start

1. Copy `.env.example` to `.env`.
2. Set `TELEGRAM_BOT_TOKEN` to your bot token. Because the original token was shared in chat, replace it through @BotFather first. Do not commit `.env`.
3. Run `npm start`.
4. Open @XEvents_bot on Telegram and send `/start`, then `/new`.

The bot runs while this process is running. For continuous availability, run it on an always-on computer or server with persistent storage. Run only one polling instance per token. Startup removes any existing webhook and uses long polling. No public web server is required.

## Features

- Persistent Create event, My events, and Help buttons. Optional inputs have Skip buttons; names have Use Telegram name; uploads have Finish uploads. Cancel input exits a step, and event pages include navigation and Invite people sharing buttons. Commands remain supported for existing users.

- Guided creation: title, date/time/timezone text, location, description, and up to 10 custom questions.
- Random invitation links to share with anyone. Guests open the link and press Start.
- Accept, decline, tentative, or respond later, with editable public RSVP comments.
- On acceptance: Telegram name or custom display name, optional own contact or typed phone number, and optional answers to organiser questions.
- Public guest list grouped by response. Phone numbers and question answers are visible only to the organiser.
- Every invited guest can contribute photos, videos, and documents, regardless of RSVP. Browse shared media five items at a time.
- Organiser controls: private responses, edit event details, replace invitation link, remove items from the shared collection, and confirm event cancellation with notifications.
- `/events` lists organised and joined events; `/cancel` abandons input without saving an unfinished RSVP.
- Events, responses, media references, conversation progress, and polling offset persist in `data/events.json` using atomic writes.

## Storage and privacy

Telegram hosts uploaded media; the bot stores reusable Telegram file IDs and metadata, not independent downloaded backups. Media and public RSVP comments are visible to anyone who joins using the invitation. Share links with intended guests. Replacing a link blocks the old invitation but retains existing guests. Removing an item hides it from the collection; it cannot remove previously delivered Telegram copies.

The local JSON database contains phone numbers and answers in plain text. Keep the data directory private and back it up securely. `.env` and `data/` are excluded from Git. Dates are displayed as entered, so explicitly include a timezone; automatic reminders and calendar integration are not implemented.

Custom questions are set during event creation. Notification delivery is best effort if a user blocks the bot. Guests who receive a link but never open it cannot be listed or messaged by the bot.

After an abrupt process termination, confirm no instance is running before removing the stale `data/bot.lock` file. On a restart during update processing, Telegram may redeliver the last update; this is a single-process implementation rather than a distributed job system.

## Verify

Run `npm test`. Tests use a fake Telegram API and temporary storage, with no token or live messages. They cover RSVP flows, privacy, organiser permissions, media, cancellation, link rotation, and persistence.

Live verification after configuration: create a test event, open its invitation from a second Telegram account, complete an RSVP, upload media, and verify the organiser's private responses. This has not been run against Telegram without a configured token.

API references: [Telegram Bot API](https://core.telegram.org/bots/api), [Telegram deep links](https://core.telegram.org/bots/features#deep-linking).
