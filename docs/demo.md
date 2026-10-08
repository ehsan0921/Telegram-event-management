# Product demo and capture provenance

[Watch the 25-second MP4](screenshots/walkthrough.mp4) · [Animated GIF](screenshots/walkthrough.gif) · [All screenshots](screenshots/README.md)

## What this shows

The actual XEvents Mini App: home, event creation, creation confirmation, organiser guest management, successful group check-in, and a guest ticket after check-in. The walkthrough is a silent sequence of screenshots, with pauses for reading; it is not a continuous interaction recording.

## Capture environment

- Captured on 8 October 2026 from source commit `80c885517abce56003e203a4b2e8cce0a869fa29`.
- Original public HTML/CSS/JavaScript and the built Worker ran locally, with an in-memory D1 database using the project's migrations.
- The capture server bound to localhost only. It supplied simulated Telegram launch data signed with a fictional test token. Its local HTML response used a small test WebApp shim; the local capture response omitted CSP so that shim could load. No application source or deployed security policy changed.
- All outbound Worker calls were intercepted. Telegram notifications, payments and third-party network requests were not sent. No production credentials, database, account or guest records were used.
- Alex Example and Sam Example, including their numeric identities, are fictional. Event venues and guest names are examples.
- The Riverside Club Picnic and accepted invitation were seeded local fixtures. Community Photography Walk was created through the actual Mini App form. The organiser entered the real locally issued six-digit code and the API confirmed a two-person group check-in.
- Mobile viewport: 430 × 932 CSS pixels. Browser captures vary slightly in image dimensions; the MP4 fits them within a 430 × 932 frame without cropping interface content.

## Boundaries

This verifies local rendering, event creation and code-based check-in against the real Worker. It does not verify Telegram's mobile WebView, chat RSVP buttons, live notification delivery, QR scanning, payments or the public bot's availability. No success state was drawn onto a screenshot.

The guest-ticket capture was made after successful check-in and correctly displays Already checked in. The displayed code can differ from the earlier organiser capture because codes rotate by minute. All codes apply only to the disposable local fixture, not any hosted event.

Before a live-product launch, verify the bot separately in Telegram with an isolated development bot. Follow the [screenshot guide](screenshots/README.md) for additional chat and QR captures. Recheck the images when the interface changes.
