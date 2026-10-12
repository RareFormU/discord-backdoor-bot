# RareForm United evidence-only activity bot

Production publication is paused. No evidence, no alert. The bot rejects Shadow, news/macro, predictive, insider, front-running and shared-funding narratives. An accepted alert must carry full mainnet transaction signatures, full wallets and exact Solscan links. It independently verifies finalized transaction success and wallet involvement, then builds only neutral evidence text.

Every remaining alert is labeled: “on-chain activity, unverified interpretation. Not financial advice. Not a prediction.” There is no accuracy, exclusive knowledge, funding attribution or news-timeliness claim.

A shared `reserve_evidence_alert` database RPC reserves the stable evidence fingerprint and destination before sending. Missing configuration, unavailable reservation or duplicate means no post. A send error never retries as text. The producer's direct webhook is disabled, preventing a second uncontrolled publication path.

Run `npm test` and `npm run build`. Keep this service and its auto-deploy paused until reviewed. The raw `rfu_alerts` table remains quarantined; these changes do not authorize restoring its public reads or restarting this bot.
