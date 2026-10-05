# XEvents Telegram bot

A private-chat event planner and Telegram Mini App for @XEvents_bot. Requires Node.js 22 or newer. Run `npm ci` to install dependencies.

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

- Super admin Telegram ID `123456789` gets an Admin tab in the Mini App with searchable lists of all events and users, event settings and guest responses. Access is read-only and checked against Telegram’s verified signed identity on every admin request. User profiles are remembered from private bot interactions and Mini App visits; legacy users are inferred from stored events, preferences and conversations. People who have never used the bot cannot be discovered by Telegram ID alone.

- Persistent Create event, My events, and Help buttons. Optional inputs have Skip buttons; names have Use Telegram name; uploads have Finish uploads. Cancel input exits a step, and event pages include navigation and Invite people sharing buttons. Commands remain supported for existing users.
- Telegram Mini App at `/app`, launched through the bot’s Planner menu or Open planner button. Includes mobile date/time controls, searchable IANA timezone selections, event creation, invitation sharing, and organiser date/time editing.
- Local timezone preferences are detected on first Mini App use and saved to the Telegram account. Users can change them in the Timezone tab. Event timezone and local display timezone are independent; changing a preference never changes an event’s start time.
- New picker events store an exact UTC instant plus the organiser’s timezone and local date/time. Both the app and chat convert these to the guest’s saved timezone. Older free-text dates remain as entered until the organiser updates them using the picker.
- Chat creation and time editing support a Pick date & time button. The picker resumes only the matching current conversation; expired picker links cannot overwrite a later input step.
- Mini App API requests validate Telegram’s signed `initData`, user identity, and one-hour freshness. Event reads and time editing enforce membership/ownership. Create requests are idempotent. Missing or repeated daylight-saving clock times are rejected with an explanation rather than silently shifted.

- Guided creation: title, date/time/timezone text, location, description, and up to 10 custom questions.
- Random invitation links to share with anyone. Guests open the link and press Start.
- Accept, decline, tentative, or respond later, with editable public RSVP comments.
- Accepted guests see Accepted and Change response instead of four RSVP buttons. My status appears only for events requiring organiser approval; guest-list and media buttons follow the organiser’s settings.
- My events groups upcoming, past, undated, and cancelled events in chat and the Mini App. Personal reminders are available 15 minutes, 1 hour, or 1 day before an exact upcoming start. Cloudflare checks once per minute; reminders follow schedule changes, skip cancelled/declined events, and keep private locations out of the notification.
- Optional event banners can be added during chat creation or uploaded through the Mini App (JPG/PNG/WebP, up to 5 MB). Organisers can replace them afterwards. Telegram stores the photo; authenticated banner reads enforce event membership without exposing the bot token.
- Visible addresses have Copy address buttons and copyable monospace text in the chat event message. Long addresses open a separate copyable message. Hidden locations remain unavailable until acceptance/approval.
- On acceptance: Telegram name or custom display name, optional own contact or typed phone number, and optional answers to organiser questions.
- Organisers do not RSVP and are excluded from guest counts. Guests get Accept, Decline, Tentative, and Later; the organiser chooses whether to enable guest lists, media uploads, and media browsing. Extras default off, including for older events without explicit permissions. Organisers retain access to all management tools.
- Guest options are selectable during both chat and Mini App creation and adjustable afterwards. Restrictions are enforced on callbacks, active upload sessions, and Mini App data, so old buttons cannot bypass them. Guest lists and counts stay private unless enabled; phone numbers and question answers always stay private to the organiser.
- Later immediately opens unanswered invitations. The bot has a Pending invitations button and the Mini App has a Pending tab. Invitations past their deadline remain listed with a closed-response label.
- Organisers can set a response deadline through native date/time controls. After the deadline, all new RSVP changes and unfinished responses are blocked, while organiser approvals and confirmed tickets remain available. A deadline must be at or before the event start when an exact start is known; removing or extending it reopens responses.
- Optional location privacy hides the location until acceptance. With approval required, location and invitation details are withheld until the organiser approves. Pending guests receive a message that the organiser will send details after approval.
- Organisers receive Approve/Reject buttons for acceptance requests and can review them in Private guest responses. Approved guests receive a personalised invitation ticket with a random reference, location, event time, and any private invitation instructions; the ticket also appears in the Mini App. Tickets are invitation confirmations, not payment receipts or a check-in system.
- Media uploads and browsing are separate permissions. Guests may contribute without browsing if only uploads are enabled. Organisers can always upload, browse, and remove items. Browse shared media five items at a time.
- Organiser controls: private responses, edit event details, replace invitation link, remove items from the shared collection, and confirm event cancellation with notifications.
- `/events` lists organised and joined events; `/cancel` abandons input without saving an unfinished RSVP.
- Events, responses, media references, conversation progress, and polling offset persist in `data/events.json` using atomic writes.

## Storage and privacy

Telegram hosts uploaded media; the bot stores reusable Telegram file IDs and metadata, not independent downloaded backups. Media is visible to guests only if browsing is enabled. RSVP comments appear to other guests only when the guest list is enabled. Share links with intended guests. Replacing a link blocks the old invitation but retains existing guests. Removing an item hides it from the collection; it cannot remove previously delivered Telegram copies.

The local JSON database contains phone numbers and answers in plain text. Keep the data directory private and back it up securely. `.env` and `data/` are excluded from Git. Dates typed as free text are displayed as entered; the Mini App picker supports automatic timezone conversion. Scheduled reminders run on the Cloudflare deployment. Calendar integration is not implemented.

Custom questions are set during event creation. Notification delivery is best effort if a user blocks the bot. Guests who receive a link but never open it cannot be listed or messaged by the bot.

After an abrupt process termination, confirm no instance is running before removing the stale `data/bot.lock` file. On a restart during update processing, Telegram may redeliver the last update; this is a single-process implementation rather than a distributed job system.

## Verify

Run `npm test`. Tests use a fake Telegram API and temporary storage, with no token or live messages. They cover RSVP flows, privacy, organiser permissions, media, cancellation, link rotation, and persistence.

Live verification after configuration: create a test event, open its invitation from a second Telegram account, complete an RSVP, upload media, and verify the organiser's private responses. This has not been run against Telegram without a configured token.

API references: [Telegram Bot API](https://core.telegram.org/bots/api), [Telegram deep links](https://core.telegram.org/bots/features#deep-linking).
