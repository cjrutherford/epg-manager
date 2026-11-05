# Tuner Daemon — UI vocabulary

The words the interface uses, and the words it should stop using. Cycle 3 of
the UX overhaul introduced this list; it is short on purpose.

## Navigation model

| Page | Answers the question |
| --- | --- |
| **Dashboard** | Is the system healthy, and what should I do next? |
| **Channels** | What channels do I have, and what is on now? |
| **Sources** | Are my playlists and guide feeds healthy? |
| **Recordings** | What recorded, what failed, and what is scheduled? |
| **Guide & matching** | How well do channels line up with the guide, and where do I fix it? |
| **Settings** | How are playlists, guide feeds, output and automation configured? |

## Preferred terms

| Use | Instead of | Notes |
| --- | --- | --- |
| **guide** | EPG, programme guide | “Guide” is the data; “guide feed” is the source. |
| **guide data** | EPG data, EPG grab | |
| **guide feed** | EPG source, XMLTV source | The source entry is a guide feed. |
| **guide match** | EPG mapping, EPG override | |
| **guide ID** | EPG ID, XMLTV ID | |
| **programme** | program (UI copy) | Use “programme” for a TV listing; “program” only in code. |
| **source** | provider, feed, registry entry | A playlist or guide feed registered in Sources. |
| **playlist** | M3U, list | |
| **channel catalogue** | repo, ipTV-org repo, FAST list | |
| **free channel** | FAST channel | Explain the benefit, not the acronym. |
| **recording** | capture, DVR item | |
| **server recording** | system recording, DVR | A recording made by the server. |
| **browser recording** | local recording, My Recordings | Or “On this device”. |
| **on this device** | local, my | Storage location, not ownership. |
| **artwork & descriptions** | metadata enrichment | The user-facing result. |
| **match rate** | confidence score | Only use “score” when a number is shown. |
| **publish output** | rebuild files | The action regenerates M3U and XMLTV files. |
| **sync** | grab, scrape | |

## Voice rules

- Sentence case for page titles, headings, buttons, tabs and labels.
- UPPERCASE only for table headers and small eyebrow text.
- Use `…` for pending actions: “Saving…”, not “Saving...”.
- Name the next step in errors: “Could not reach the server. Check that it is
  running, then try again.”
- Never show a database key, registry key or internal ID unless the user needs
  it to match external data.
- A destructive button names the object: “Delete recording”, not “Delete”.
- Prefer “on this device” and “on the server” over “local” and “system”.

## Screen-level copy

- **Sources** — “Health and sync status for every playlist and guide feed.”
- **Recordings** — “Scheduled, recording and completed programmes on the server
  or in this browser.”
- **Guide & matching** — “How well your channels line up with the guide, and
  where matches need help.”
- **Settings** — “Playlists, guide feeds, output files and automation.”
