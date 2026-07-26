# Notices feed (`https://sei.gg/notices.json`)

Operator announcements delivered to the desktop app's Inbox. Hosted on the
website next to `version.json`, but **not linked or rendered anywhere on the
site**: it exists for the app, and web visitors never see an inbox.

## Delivery

The app refreshes this feed on exactly the same cadence as the update check
(`src/main/updater.ts`): at startup, on window focus, on machine resume /
screen unlock, on the 30-minute backstop timer, and on a manual "Check for
updates". All of those share one throttle (20 minutes minimum between
automatic checks), so publishing a notice reaches an open app within about
20 minutes of the user next touching it, and immediately on next launch.

A notice the app has not seen before opens the Inbox **once**, on the newest
unread entry. After that it is reachable from Playtime, under Submit feedback,
as "Inbox" (with an unread count). Read/announced state lives in
`<userData>/notices.json` and is device-global, so it survives account
switches.

## Format

```json
{
  "notices": [
    {
      "id": "260725-voice-calls",
      "title": "Voice calls are here",
      "date": "2026-07-25",
      "body": "Your companion can talk now.\n\n![Call screen](https://sei.gg/img/call.png)\n\n- Pick a voice in Edit companion\n- Press the phone button in chat\n"
    }
  ]
}
```

A bare top-level array (`[ {...} ]`) is accepted too.

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Stable and unique, **never reused**. Identity for the announced/read marks: change it and the notice re-announces itself to everyone. |
| `title` | yes | Left-column label and the reading pane's heading. |
| `date` | no | ISO date (`2026-07-25`). Sorts the feed newest-first and prints in the inbox. Missing/unparseable dates sort last. |
| `body` | yes | Markdown, see below. |

Order in the file does not matter; the app sorts by `date` descending.

Removing an entry from the feed removes it from every inbox on the next
refresh, but its announced/read marks are kept, so re-publishing the same `id`
does not re-open the inbox.

## Body markdown

Parsed by `src/renderer/src/lib/noticeMarkdown.ts` into a typed AST and
rendered as React elements. **Raw HTML is not supported and renders as literal
text**. The supported subset is the allowlist, so there is nothing to
sanitize and nothing to bypass.

Blocks: `#` `##` `###` headings, `-` / `*` bullet lists, `1.` ordered lists,
`>` quotes, `---` rules, ``` fenced code, and blank-line-separated paragraphs
(single newlines inside a paragraph become soft line breaks).

Inline: `**bold**`, `*italic*` / `_italic_`, `` `code` ``, `[text](url)`, and
`![alt](url)` images.

Two constraints on URLs:

- **Images and links must be `https:`** (links may also be `mailto:`).
  Anything else degrades to plain text. Images load straight from the remote
  URL, so host them somewhere stable.
- **Links may point at any https site.** They open in the OS browser via
  `shell.openExternal`, gated only on protocol
  (`src/main/lib/externalUrlValidator.ts`). The host allowlist was removed on
  2026-07-25 precisely so a notice can link anywhere without a client release.

  One version caveat: builds from before that change still enforce the old
  allowlist (`sei.gg`, `dmca.copyright.gov`, `polar.sh`), so a link to any other
  host is a dead click there. Nothing breaks, it just does nothing.

## Copy rules

Same as the rest of the app: no em dashes in anything a user reads.

## Publishing checklist

1. Add the entry to the website's `notices.json` with a fresh `id`.
2. Deploy the site.
3. Verify with `curl -s https://sei.gg/notices.json | jq .` before announcing.
