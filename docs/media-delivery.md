# Media delivery scheduling

The delivery lease coordinates one bounded pool, rather than holding each media
API request behind the previous request. Three independent lanes take the next
eligible chat. A slow call occupies its lane, not all three. Existing priority
control delivery remains independent of the media pool.

Each chat has a durable owner/expiry claim and FIFO outbox head across albums.
Compatible consecutive media can be grouped up to ten files; coalescing cannot
jump another album's item in the same chat. Last-served priority changes at
actual API admission, not when a pacing reservation is made. Claims and owner
checks prevent another drainer from sending the same chat concurrently.

Media dispatch admission is paced at least 500 ms apart globally and one second apart
per chat, with at most three active media calls. This conservative media budget
leaves headroom for the existing priority controls and other bot traffic; it is
not a promise that Telegram will never return 429. A real 429 pauses media
globally and for that chat until retry_after. Telegram does not identify the
scope of every 429, so the global media pause is intentionally conservative.

Permission/receipt mutations retain the state transaction lease, but load whole
recipient preference/session records and their delivery albums instead of all
users/events. Full bot actions and control rendering retain their existing
complete state view. Pacing waits and remote calls never hold the state lease.

An attempted-send marker is persisted before the remote call, and a successful
receipt is persisted before applying received counts. Recorded receipts can be
committed after restart without sending again. An interrupted attempt without
a receipt, transport failure, or invalid/partial response remains uncertain.
It is never blindly retried. Later media for that chat waits for explicit user
review/retry, or a genuinely recorded receipt resolving the uncertainty.
Other chats can continue. An explicit new Get/Send can clear a stale runtime
hold when no accessible active uncertainty remains; inaccessible uncertainty
is retained and is never automatically retried. This is deliberately not an
exactly-once claim:
Telegram sendMediaGroup has no idempotency key, and an explicit retry may repeat
a file whose earlier delivery could not be confirmed.

Chat claims and claimed rows expire after 120 seconds; the coordinator lease is
renewed under its owner. Expired claims are recoverable by subsequent drains,
including the existing scheduled drain. A crash can therefore delay recovery
until the claim expires and another drain runs. Unknown outcomes stay held;
recovery does not erase receipts, media or user data. No database migration is
needed: runtime coordination uses separate records kinds, which are removed
only when preparing an offline production-to-development snapshot.

Cancel records the exact user's/job's remaining tokens. It is rechecked after
pacing and before API dispatch. A request already in flight may still arrive;
its real receipt remains authoritative. Failure to update a control message
cannot cause a media resend. The compact Cancel/count keyboard and Sending....
message are unchanged.

Telemetry separates media_scheduler_admitted.admissionMs from
media_transport_result.elapsedMs. Neither log includes chat/user/media IDs.
Synthetic tests cover artificial network latency and large fault workloads;
their timing is not a measurement of production Telegram or phone clients.
# Album refresh controls

The album main menu uses Telegram's regular reply keyboard. Its last row is Follow:ON/OFF, More and 🔄 Refresh. Album Refresh reloads the current authorized album and its Get all/Get new counts; it does not request media, clear holds or replay prior delivery status. The explicit /refresh command remains available for delivery review. Legacy inline album callbacks continue to work. Delivery retains its scoped Cancel button, with album controls available below it, and restores the album keyboard afterward.

Open album app is a plain reply-keyboard command that returns an authenticated inline Web App launcher for the same album. Telegram keyboard-button Web Apps do not provide signed initData, so placing web_app directly in the reply keyboard cannot authenticate this app. The inline launcher and built-in App menu use Telegram's signed launch data; no authentication bypass or browser identity is accepted. A stale keyboard launch can recover through a validated albumapp deep link, which rechecks current album access before providing the secure launcher. This requires one extra tap from the reply keyboard, and never resends media or clears draft input.

