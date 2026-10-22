# Changelog

## 0.4.0

**New**
- **"+" button** (like Arc's) on Gmail (new mail) and Calendar (new event).
- **Gmail pages:** up to 3 pages of mail, side by side; scroll, swipe or use the dots.
- **Calendar:** today as a timeline with a red line for now, and a colour per calendar (with its name).
- **GitHub:** ✓ marks a notification as read; it leaves the card and the badge at once.
- **Weather card** (Open-Meteo) for weather sites, or any Essential.
- **Show as:** right-click an Essential to choose its card (or just the page).
- **Pin** a preview open; **Show more** for more items; resize the card from its corner.
- **Setup inside the card** instead of a dialog box, with validation and a link to where to get the value.
- **Better errors:** "Sign in" for Gmail, "Try again", or the right setup button.
- **Cards from other mods:** `ZenPeek.registerCard(...)` (see the README).
- **Themes:** the card uses Zen's panel colours, so it matches Zen and theme mods (or choose Zen Peek's own colours).

## 0.3.2

**Changed**
- Badges look like Arc's: a small dot in the Essential's bottom-right corner, away from the icon, with a soft pop-in. The dot is now the default; "With the number" shows a compact pill in the same corner.

**Fixed**
- Numbers didn't show in badges (the badge was an empty red circle).

## 0.3.1

**Fixed**
- Compact mode: the preview no longer closes when you move the mouse from an Essential to it. The sidebar used to slide away as soon as the mouse left it, taking the Essential with it (classic closed at once; the floating card closed on the next move). The sidebar now stays out while a preview is open, the same way Zen keeps it out for its own menus.
- Added the `ai` field to `theme.json` for the Sine marketplace.

## 0.3.0

**New**
- Unread badges on Essentials: Gmail unread, GitHub review requests + notifications, and counts read from page titles (Slack, Discord, WhatsApp, Telegram, Messenger…). Number, dot, or off.
- Calendar: a **Join** button for Meet, Zoom, Teams, Webex, Jitsi and Whereby meetings.
- GitHub: CI status (✓ ✗ ●) on your pull requests.
- Keyboard: Alt+Shift+P (or Ctrl+Alt+P) previews the focused Essential; ↑/↓ move, Enter opens, ←/→ switch Essential, Esc closes.
- Turkish translation; language follows Zen or can be chosen.
- Smart closing: the preview stays open while the mouse moves toward it, and Essentials crossed on the way don't steal it.

**Faster**
- Default hover delay 0.3 s (was 0.5 s).
- Essentials' data is refreshed in the background (only in the window you use, when idle).
- Data is shared between windows and, optionally, kept between restarts.
- GitHub uses one GraphQL request instead of four searches (REST is the fallback).
- Hacker News stories and page snapshots are reused for a short time.

**Fixed**
- Right-click menu items no longer duplicate after an update without a restart.
- Requests time out (configurable) instead of loading forever.
- Rate limits (429, GitHub's 403) show when it will retry, and no requests are made until then; failing services back off.
- Recurring events like "2nd Tuesday", "last Friday", "last weekday of the month", yearly rules and weekdays-only daily events.
- Gmail's feed is read with a real XML parser.
- Text colours meet WCAG AA; high-contrast mode is supported; rows are keyboard-accessible links.

**Under the hood**
- Card registry (`mod/cards.uc.js`), texts in `mod/strings.uc.js`, LRU cache, ESLint, type checks, version check and CI.

## 0.2.0
- In-window classic preview, prefetch, stale-while-revalidate, diagnostics.
