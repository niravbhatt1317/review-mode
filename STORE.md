# Publishing on the Chrome Web Store (unlisted)

One-time: https://chrome.google.com/webstore/devconsole → sign in with the Google account that will own the listing
(a work account) → pay the one-time $5 registration → verify the email.

## Each release

1. `node review-extension/pack.mjs` (or `… minor`): bumps the version, writes `dist/review-mode-<version>.zip`.
2. Developer dashboard → the item (first time: **New item**) → **Package** → Upload new package → the zip.
3. First time only: fill the listing from below, set **Visibility: Unlisted**, submit for review.
4. **Submit for review**. The first review takes a few days; later ones are usually minutes to hours. Everyone who
   installed it gets the new version automatically (Chrome checks a few times a day).

The install link for the team is the item's store URL (`https://chromewebstore.google.com/detail/<id>`). Edge users
install from the same link (Edge allows Chrome Web Store extensions after one confirmation).

## Listing

**Name**: Review mode
**Summary** (132 chars max): Design review on any page: hold ⌥, click anything, write a comment. Pictures, statuses and notes go to your team's hub.
**Category**: Developer Tools
**Language**: English

**Description**:
Review mode lets a design team leave comments on a running product, right on the element they mean. Hold ⌥ (Alt on
Windows), click anything on the page, write the comment, pick a tag. The extension takes a picture of the screen at
that moment, with a box around the element and the comment's number, and sends the comment and the picture to the
team's shared hub. Teammates see new comments within seconds, pick them up, mark them done, send them back with a
reason, and the reviewer approves. A list of every comment opens from the bar at the bottom of the page or as a
full page of its own. Copies for a Claude brief or a Microsoft Loop checklist are one click.

The extension works on any page once you switch that site on with the toolbar button. It does nothing on sites that
are not switched on.

**Privacy / single purpose**: The extension has one purpose, design review comments. On a site that the user has
switched on it sends the user's comments and screenshots of that page to the team's own backend (a Supabase project
configured in the extension). Nothing is sent anywhere else, nothing is sold or used for anything other than showing
the comments to the team. On sites not switched on it reads nothing.

**Permission justifications** (the form asks for each):
- `host_permissions <all_urls>`: review has to work on whatever page the team is reviewing (staging sites, prototypes,
  the product itself); the overlay is only injected on sites the user switches on with the toolbar button.
- `scripting`: injects the review overlay into a page the user has switched on.
- `tabs`: takes the picture of the tab the comment was made in (`captureVisibleTab`) and knows which site the
  toolbar button was pressed on.
- `storage`: remembers which sites are on, their project names and the user's handle.
- Remote code: none. All code ships in the package; the overlay is a file inside it.
- Data use: user activity (comments) and website content (screenshots) are sent to the team's backend to provide the
  feature; not sold, not used for unrelated purposes, not for creditworthiness or lending.

**Icon**: `icons/128.png`. **Screenshots** (1280×800): one of the overlay with a comment card on a page, one of the
list. Take them from a real review session.

## Edge Add-ons (optional, later)

Not needed: Edge installs from the Chrome Web Store. If IT wants a Microsoft-side listing, the same zip goes to
https://partner.microsoft.com/dashboard/microsoftedge (free registration).

## Firefox (Mozilla add-ons, unlisted)

Firefox needs its own package (the pack script writes `dist/review-mode-<version>-firefox.zip`: same files, a
background script instead of a service worker, the add-on id `review-mode@motadata.com`) and Mozilla must sign it,
even for a private add-on. Free, automated, minutes.

1. https://addons.mozilla.org/developers/ → sign in with a Firefox account (free) → **Submit a New Add-on**.
2. **On your own** (unlisted), upload the Firefox zip, answer the two questions (no minified code, no remote code).
3. After the automatic check, download the signed `.xpi`. Share it; Firefox installs it on open (drag it onto the
   window or File → Open). Each release: upload the new zip, share the new `.xpi`.
4. For automatic updates, the manifest would need an `update_url` pointing at a small JSON you host (GitHub Pages or
   a public bucket) that lists the latest `.xpi`; worth adding once more than one person is on Firefox.

Firefox treats "access to all sites" as optional: the toolbar button asks for that site's permission on the first
click, and on the console (localhost:4178) the person clicks the button once too, so the add-on may take pictures
there. Firefox 128 or newer.
