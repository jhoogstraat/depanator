# Saved IS24 responses

`<data directory>/raw/` holds the IS24 responses that went wrong, exactly as IS24 sent them. It is the only record of what IS24 returned: the database keeps parsed listings and the log keeps error text. Start here when a listing looks wrong or IS24 fails.

The data directory is `DEPANATOR_DATA_DIR`: `/data` in the container, `.depanator/` otherwise. Each new file logs `Kept IS24 response <path>: <problem>`, so the log gives the time and the file name.

## Files

Each file is `<label>-<first 12 hex of the body's SHA-256>.json`, so an identical body is stored once and a changed body gets a new file:

```json
{ "at": "2026-10-30T15:31:36.378Z", "problem": "Listing without price", "body": {} }
```

`body` is the parsed JSON, or the verbatim text for a failed response. `problem` is the reason it was stored. `at` is the first time this body was seen.

| Label | Stored when |
| --- | --- |
| `expose-<id>` | The listing has empty facts (`title`, `price`, `area`, `rooms`, `address`, `description`), has a title picture in the search but no picture in the expose (`Listing without photos`: IS24 may have changed the `MEDIA` section `readPictures` in `src/is24.js` reads), or the request failed: 401/403/429, another HTTP error, non-JSON, invalid JSON |
| `search-list` | The search request failed the same ways, or its JSON has no valid `resultListItems`/`numberOfPages` |
| `search-item-<id>` | One search result has empty facts, first time the listing is seen |
| `search-item` | One search result has no usable listing ID |
| `contact-<id>` | The contact request got any non-2xx answer, including the HTTP 500 IS24 sends for delivered requests |

Everything else leaves no file: 404/410 (a listing going offline is routine), Immomio, Telegram and ChatGPT responses, and network errors with no response.

A listing's story reads across files: compare `search-item-<id>` with `expose-<id>` to tell which endpoint lacked a fact, and sort by `at` to see a fact appear.

## Debugging

- A missing fact in both `search-item-<id>` and `expose-<id>` points at IS24's data. In the expose only, it points at `readExpose` in `src/is24.js`.
- Compare the failing body with the label `readExpose` expects before changing it; rent labels decide warm or cold rent, and the two must stay apart.

## Writing a test from a saved response

Copying a saved response into a test is a manual step:

1. Take `body` (`jq .body <file>`) and trim it to the sections the behaviour reads.
2. Remove personal data: the `contact` section, agent names, phone numbers, email addresses, addresses that include a street. Keep the raw files themselves out of the repository, since it is public.
3. Add the path to `test/e2e.test.js`, the project's only test suite: it runs the real agent against fake services. Serve the trimmed response through `world.respond` in `test/support/world.js`, and read what the agent saved through `world.kept()`.

`raw/` is never pruned; delete files once they are turned into tests.
