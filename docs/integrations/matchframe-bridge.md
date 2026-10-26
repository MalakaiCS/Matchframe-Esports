# MatchFrame bridge contract

**Status: blocked.** The existing MatchFrame service's API, authentication and data model were not available. Matchframe Esports speaks this documented contract through an optional adapter; the MatchFrame side needs a thin implementation. Bridge failures never affect local CS2 broadcasts.

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/capabilities` | `{ contractVersion: 1, results, assets, sponsors, graphics: boolean }` — discovery decides what is used |
| PUT | `/v1/results/:externalMatchId` | Idempotent result upsert (`idempotency-key` header). Body: `{ externalMatchId, status, bestOf, teams: [{name, shortName, seriesScore}×2], maps: [{order, mapName, status, scores: [a, b], winnerIndex}], updatedAt }` |
| GET | `/v1/assets` | `{ assets: [{ id, name, kind, sha256, url }] }` — shared branding/graphics/sponsor assets |

Configure: `PUT /api/v1/integrations/matchframe` `{ enabled, url, autoPushResults, token? }`; check with `POST /api/v1/integrations/matchframe/discover`.
