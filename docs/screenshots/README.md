# Product screenshots

This directory includes real XEvents Mini App captures from an isolated local Worker/D1 fixture, using fictional users and events. Telegram identity is simulated locally and all outbound calls are mocked. These are not live Telegram chat screenshots. See [demo provenance](../demo.md).

## Included captures

| File | Actual captured state |
| --- | --- |
| [home.jpg](home.jpg) | Organiser home and upcoming fictional picnic |
| [create-event.jpg](create-event.jpg) | Filled photography-walk creation form |
| [event-created.jpg](event-created.jpg) | Successful creation through the Mini App |
| [guest-list.jpg](guest-list.jpg) | Seeded accepted and unanswered named invitations |
| [guest-ticket.jpg](guest-ticket.jpg) | Fictional guest ticket after check-in |
| [check-in-keypad.jpg](check-in-keypad.jpg) | Organiser keypad awaiting a guest code |
| [check-in-result.jpg](check-in-result.jpg) | Successful two-person group check-in through the real local API |
| [walkthrough.mp4](walkthrough.mp4) / [walkthrough.gif](walkthrough.gif) | 25-second silent sequence of captures |

The names and numeric identities displayed are fictional test fixtures. Published codes belong only to the disposable local database and cannot admit anyone to a hosted event. No QR codes or private hosted links are included. Live Telegram RSVP-chat and optional QR-flow captures remain future work.

## Four captures for the README

| Filename | Screen to capture | What should be visible |
| --- | --- | --- |
| `home-explore.png` | Mini App Home, with a future public event suggestion | The bot icon, a fictional profile name, upcoming plans and the Home / Explore / Create / My events / Profile navigation. If Explore shows the product more clearly, capture its real search and timezone-matched results instead. |
| `create-event.png` | Mini App Create event | A fictional event title, timezone, date and time, invitation mode and the collapsed optional settings. Keep the form readable rather than trying to show every setting. |
| `invitation-rsvp.png` | A named invitation in the Telegram chat | A fictional guest name, event title and local schedule, response deadline, and Accept / Reject / Maybe / Respond later buttons. Capture before the final response consumes a one-time link. |
| `ticket-check-in.png` | Mini App ticket with QR enabled | A confirmed test booking, ticket code and QR, with the event title and group size where displayed. Check the same test ticket through the organiser's check-in flow before publishing. A separate `check-in-result.png` may show the real result if needed. |

Use a small fictional event such as **Riverside Club Picnic**, with names such as **Alex Example** and **Sam Example**. Choose a future date and a real timezone. Keep the same event, theme and mobile width across the set when practical. Do not add real addresses, phone numbers or participant photos.

## Capture safely

1. Use an isolated development bot and database, or the project's local test preview. Never use production guest records for documentation.
2. Create the event through the actual product. For the invitation capture, use named mode with a fictional guest. For the ticket capture, use a separate ticket-booking test event and explicitly enable QR codes; new events have QR codes off by default.
3. Capture the real interface after it finishes loading. A local preview can show layout, but verify the invitation buttons and QR check-in in Telegram with the development bot before describing the set as a live demonstration.
4. Crop browser and desktop chrome where useful. Exclude authentication data, numeric Telegram user IDs, private invitation or upload URLs, hosting URLs, notifications and unrelated chats. Do not publish a QR that opens a private link or admits anyone to a production event.
5. Use only a test ticket code and QR from the isolated environment. Revoke or delete the test event after capturing, so a published code cannot grant entry. Preserve the screenshot's actual UI state; do not draw a successful check-in or other unsupported result onto it.
6. Review every image at full size and decode any visible QR before publishing. Check the background, browser address bar, Telegram chat header and image metadata for private information.

## Image quality and README use

Capture mobile screens at a consistent width, for example a 390 CSS-pixel viewport, and export clear PNGs at the device's native resolution. Use a consistent light or dark theme, readable text and a tight crop. Avoid decorative device frames that make the interface too small.

Keep original captures locally if they contain sensitive device chrome; publish only reviewed copies. Once the four files exist, add relative image links in the [main README](../../README.md) with descriptive alt text and short captions. Until then, link to this capture plan rather than showing broken image placeholders. Update captures when the visible product flow changes.

The existing X wordmark and green palette in [the app header](../../public/index.html) and [stylesheet](../../public/style.css) can guide accompanying branding. The administrator's bot icon is loaded at runtime and is not a checked-in screenshot asset.
