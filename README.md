# XEvents

**Open-source event management inside Telegram.**

Create events, invite guests, collect RSVPs, issue tickets, check people in, and share media in event galleries or standalone albums without leaving Telegram.

**[Try XEvents on Telegram →](https://t.me/XEvents_bot)** · [Demo walkthrough](#try-the-demo) · [Self-hosting](docs/self-hosting.md) · [Contributing](CONTRIBUTING.md)

![XEvents: Create an event, invite your guests, collect RSVPs, and check in. Open-source Telegram Mini App.](docs/assets/xevents-banner.svg)

[![MIT licence](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE) [![Telegram Mini App](https://img.shields.io/badge/Telegram-Mini_App-26A5E4?logo=telegram&logoColor=white)](https://t.me/XEvents_bot) [![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](docs/architecture.md)

For clubs, meetups, workshops and community gatherings. Hosts and guests use Telegram; there is no separate app to install.

## Try the demo

1. Open **[@XEvents_bot](https://t.me/XEvents_bot)** and press **Start**.
2. Tap **Create**, then choose **Event** or **Media album**. Use **App** to explore the Mini App.
3. For your own event, choose a shared ticket-booking link or a named guest list with personal RSVP links.
4. Manage replies and guests, then use **Check in guests** on event day.
5. Open **My stuff** to find your events and albums. In the Mini App, tap **My stuff ▾** and choose **Events** or **Media albums** from its dropdown menu.

### A look inside

Real app screens, captured locally with fictional events and mocked Telegram calls:

<img src="docs/screenshots/walkthrough.gif" width="300" alt="Animated XEvents walkthrough showing event creation, the guest list, check-in and a guest ticket">

[Open the animated walkthrough](docs/screenshots/walkthrough.gif) · [Capture details and limitations](docs/demo.md)

<table>
<tr><td><img src="docs/screenshots/home.jpg" width="240" alt="XEvents home with the fictional Riverside Club Picnic event"></td><td><img src="docs/screenshots/create-event.jpg" width="240" alt="Event creation form with a fictional photography walk"></td></tr>
<tr><td>Home and upcoming plans</td><td>Create an event</td></tr>
<tr><td><img src="docs/screenshots/guest-list.jpg" width="240" alt="Organiser guest list with fictional accepted and unanswered invitations"></td><td><img src="docs/screenshots/check-in-result.jpg" width="240" alt="Successful local check-in for Sam Example and a two-person group"></td></tr>
<tr><td>Manage RSVPs and group counts</td><td>Check in guests</td></tr>
</table>

[Download the optional MP4 version](docs/screenshots/walkthrough.mp4)

The walkthrough is a silent sequence of actual local UI captures, not a live Telegram recording. The public bot is a live service. For experiments, use your own development bot and fictional data following the [self-hosting guide](docs/self-hosting.md).

## Features

| For organisers | For guests |
| --- | --- |
| Create events in chat or the Mini App, with timezones and reminders | Open invitations and see local event times |
| Share booking links or personal invitations; manage co-hosts | Accept, Reject, Maybe or Respond later on named invitations |
| Track group counts, approval requests and attendance | Receive tickets after required approval and payment |
| Check in groups with on-demand codes or optional QR tickets | Request a short-lived check-in code; use QR when enabled |
| Configure free events, manual payments or Telegram Stars | Share photos, videos and files in the event gallery |
| Create standalone media albums with separate viewer and contributor links | Browse shared albums or upload using a contributor link |
| Control guest-list, media and private-location access | Access private details when attendance requirements are met |

QR codes are optional and off for new events. Stars payouts to organisers are manual. Direct card processing and calendar synchronisation are not implemented.

### Create and find your stuff

The bot's main keyboard has two rows:

| | | |
| --- | --- | --- |
| **Create** | **My stuff** | |
| **App** | **Settings** | **My account** |

**Create** asks whether you want an event or a media album. **My stuff** brings together events you host or have joined and albums you can access. In the Mini App, tapping **My stuff ▾** opens a dropdown on the navigation button with **Events** and **Media albums**. **Settings** opens profile settings; **My account** shows your name, timezone and display currency with an option to edit your profile.

### Shared media albums

Create an album without an event date, guest list, tickets or RSVPs. In chat, choose **Create → Media album** and enter a name. In the Mini App, choose **Create**, then the media option. Share the resulting links:

- **Viewer link:** lets anyone holding it browse the album.
- **Contributor link:** lets anyone holding it browse and add files. Share it only with people you want to contribute; it does not grant ownership or management access.

Albums accept photos, videos, audio, voice messages, animations, video messages, stickers and arbitrary files sent as Telegram documents, including PDFs and ZIP archives. Uploads happen in the bot chat: open the album's **Add media** action, send files, then tap **Finish uploads**. Existing event galleries support the same file types.

The Mini App shows previews for supported image and video formats. Other formats remain available through **Download** and **Send to Telegram**. Uploader names appear on gallery cards and in full-size previews. Album owners can turn **Show who uploaded media** off; this hides names from the gallery and bot attribution, while captions and file contents remain visible.

There is no built-in photo-count limit. Telegram and hosting limits apply; Mini App downloads support files up to 20 MB, with **Send to Telegram** available for larger files. Existing invitation and album links remain supported.

[Full feature guide](docs/features.md) · [Invitations and guest counts](docs/invitations.md) · [Payments and refunds](docs/payments.md)

## Run XEvents yourself

You need **Node.js 22+**, npm, your own Telegram bot, and Cloudflare Workers with D1.

```sh
git clone https://github.com/ehsan0921/Telegram-event-management.git
cd Telegram-event-management
npm ci
cp .dev.vars.example .dev.vars
# Fill .dev.vars with your own development bot secrets before continuing.
npx wrangler d1 migrations apply xevents --local
npx wrangler dev
```

Open the local **/app** route to preview the interface. Signed Telegram identity is required for private data; follow [local and Telegram setup](docs/self-hosting.md#run-the-worker-locally) for a complete flow. Keep development and production bots separate.

XEvents is MIT-licensed JavaScript with a plain HTML/CSS Mini App. A Cloudflare Worker serves the webhook, Mini App and API; D1 stores records, and Telegram hosts uploaded media. Provider quotas apply: unlimited free hosting or storage is not promised. [Architecture and limits →](docs/architecture.md)

## Documentation

| Guide | Purpose |
| --- | --- |
| [Detailed overview](docs/overview.md) | Extended introduction, invitation examples and quick start |
| [Self-hosting](docs/self-hosting.md) | Your own bot, database, secrets and deployment |
| [Development](docs/development.md) | Separate environments and required checks |
| [Features](docs/features.md) | Supported flows and examples |
| [Invitations](docs/invitations.md) | RSVP, guest counts, co-hosts and check-in |
| [Payments](docs/payments.md) | Manual review, Stars and refunds |
| [Architecture](docs/architecture.md) | Code map and operational constraints |
| [UX review](docs/UX-review.md) | User journeys and test boundaries |

## Contributing

Bug reports, documentation, accessibility improvements and focused pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md). Run **npm test** for regression coverage and **npm run test:worker** for the Worker bundle and local database checks.

Keep tokens, private deployment settings and real guest data out of issues and screenshots. Report vulnerabilities privately through [SECURITY.md](SECURITY.md).

[MIT licence](LICENSE) · **[Plan your next event with XEvents →](https://t.me/XEvents_bot)**
