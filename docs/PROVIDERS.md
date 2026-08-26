# Scraper Provider Backend

Tsukuyomi routes certain scrape requests through third-party provider APIs to handle bot-detection and JS-rendered pages. This document explains which providers are supported, how to add your API keys, and how the routing logic works.

## Why providers?

Some novel sites (FreeWebNovel in particular) reliably return Cloudflare or similar bot-detection challenges to plain HTTP requests. Provider APIs proxy those requests through residential/rotating infrastructure and optionally render JavaScript, returning clean HTML to the app.

Providers are **optional** for most sources. They are only **required** for FreeWebNovel, which always uses the provider path.

## Supported Providers

| Provider | ID | Pricing tier |
| :------- | :-- | :----------- |
| [Scrape.do](https://scrape.do) | `scrape-do` | Free + paid |
| [ScrapingAnt](https://scrapingant.com) | `scrapingant` | Free + paid |
| [ZenRows](https://zenrows.com) | `zenrows` | Free + paid |
| [Zyte](https://zyte.com) | `zyte` | Paid only |

All four providers offer free tiers sufficient for personal use. Sign up on their respective sites to get an API key.

## Adding API Keys

API keys are managed in the desktop (Electron) app under **Settings → Scraper Providers**.

For each provider you want to use:

1. Open **Settings → Scraper Providers**.
2. Click **Add credential**.
3. Fill in:
   - **Label** — a name for this key (e.g. `My Scrape.do key`)
   - **Provider** — select from the dropdown
   - **API key** — paste your key from the provider dashboard
   - **Paid plan** — check this if your account is on a paid plan; leave unchecked for free-tier keys
   - **Max concurrency** — how many parallel requests this key may make (check your plan limit; default `1` is safe)
   - **Monthly cost limit** — optional cap in USD; the app stops using this key when the estimated spend reaches the limit
4. Check **I confirm this key is authorized for use** and click **Save**.

Keys are encrypted at rest using the OS keychain and stored locally — they are never sent anywhere except the provider's own API endpoint.

To edit or remove a key, click the key label in the list and choose **Edit** or **Remove**.

## Credential Storage

Keys are saved to a local file at:

- **macOS / Linux**: `~/.config/tsukuyomi/provider-credentials.json`
- **Windows**: `%APPDATA%\tsukuyomi\provider-credentials.json`

The file is encrypted (AES via the OS secure storage) and readable only by the current user (`chmod 600`). Do not edit it manually.

## Fetch Routing

Each import request goes through a provider route determined by its source:

| Source | Route |
| :----- | :---- |
| FreeWebNovel | `scrape-do → scrapingant → zenrows → zyte` (providers only) |
| NoBadNovel, NovelLunar | `direct → scrape-do → scrapingant → zenrows → zyte` |
| Kakuyomu, ncode.syosetu | `direct` only |

The gateway tries each step in order and falls back to the next only on retryable errors (`challenge_detected`, `rate_limited`, provider 5xx). It stops as soon as a step succeeds or hits a non-retryable error.

FreeWebNovel always skips `direct` because plain requests are reliably blocked.

## Fetch Modes

Each provider supports two fetch modes:

- **http** — plain HTTP proxy; fast and cheap; used by default for NoBadNovel and NovelLunar fallbacks
- **browser** — JS rendering (headless browser at the provider); used by default for FreeWebNovel and always for Zyte

The mode is chosen automatically per source. You do not need to configure it.

## Cost Tracking

The app tracks estimated spend per key per calendar month. When a key's `monthlyCostMicrosUsed` reaches `monthlyCostLimitMicros`, that key is skipped for the rest of the month. Costs reset on the 1st of each month.

Approximate worst-case cost per request (provider list price):

| Provider | Max cost per request |
| :------- | :------------------- |
| Scrape.do | ~$0.0012 |
| ScrapingAnt | ~$0.0019 |
| ZenRows | ~$0.0088 |
| Zyte | ~$0.0161 |

For personal use (a few novels a month) free-tier credits are typically sufficient.

## Error Reference

| Code | Meaning | What to do |
| :--- | :------ | :--------- |
| `provider_unavailable` | No API key configured, or key is disabled / over budget | Add or re-enable a key in Settings |
| `provider_error` | Provider returned an unexpected response | Usually transient; retry or try another provider |
| `budget_exceeded` | Monthly cost cap reached for all available keys | Raise the limit or wait for the monthly reset |
| `challenge_detected` | The target site returned a bot-detection page despite the provider | Try a provider with browser rendering (ZenRows, Zyte) |
| `rate_limited` | Provider or source is rate-limiting requests | The gateway backs off and retries automatically |

## Troubleshooting

**FreeWebNovel imports always fail with `provider_unavailable`**
You have no API keys configured. Add at least one key for any supported provider in Settings.

**Key shows as disabled after a few imports**
The monthly cost limit was reached. Go to Settings, raise the limit, or wait for the next month.

**`challenge_detected` persists even with a provider key**
Switch to a provider that supports browser rendering — ZenRows (`js_render`) or Zyte (`browserHtml`). Make sure the key's **Paid plan** checkbox reflects your account tier, as browser rendering is often a paid feature.

**Keys are not persisted after reinstall**
The credential file is stored in your OS config directory (see above). Back it up before reinstalling, or re-add your keys afterwards.
