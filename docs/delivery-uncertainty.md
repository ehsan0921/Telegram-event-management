# Delivery uncertainty and refresh

An ambiguous Telegram outcome never proves delivery or failure. Keep its per-file uncertainty and hold later batches for that chat; do not automatically retry media. A partial/invalid receipt is also unconfirmed rather than sent. Other chats continue independently.

Refresh reports the current/recent job counts, rather than lifetime unique received IDs from earlier Get all requests. It separates confirmed, queued, in-flight, stopping, unconfirmed, failed and cancelled. Queued files are explicitly paused when the chat has uncertainty. It never clears the hold or retries files and preserves any existing form/upload input.

Managed jobs use their existing compact progress message for uncertainty. Legacy jobs get one durable warning per media token; recovery does not enqueue it twice. A warning whose API result is ambiguous is not blindly retried. A definite 429 can be retried after backoff. A crash between recording a warning attempt and sending it may suppress that warning; refresh remains available. No exactly-once Telegram send guarantee is claimed.

Future per-file diagnostic categories distinguish timeout, network failure, invalid response, API error, invalid/partial receipt and recovered interrupted attempt, without retaining secrets or response bodies. Older unknown records cannot retrospectively prove a timeout.

Synthetic regression scenarios include a 194-file job with 130 confirmed, ten uncertain and 54 held in six batches; repeated/concurrent refresh with form input; legacy notification recovery and ambiguous/429 results; partial receipts; late confirmed receipts versus stale uncertainty; and isolation from another user. Real user media, queue and receipts are never reset for testing.
