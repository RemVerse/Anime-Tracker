# YomiList

A complete personal anime tracker built with HTML, CSS, and vanilla JavaScript. Real anime information and artwork come from the public AniList GraphQL API. No build step, application dependencies, API keys, account, or backend are required.

## Run locally

Open `index.html` in a modern browser to get started. For a consistent localStorage origin, a local server is recommended:

```sh
cd "Anime Tracker"
python3 -m http.server 8080
```

Open http://localhost:8080. Keep using the same address and port: browser storage belongs to each origin. Internet access is required for AniList searches, discovery, artwork, and optional Google Fonts. The interface falls back to system fonts automatically.

## Use the app

- Search by English or Romaji title using the top search field. Enter searches immediately; typing searches after a short pause. `/` focuses search.
- Open a cover to see the synopsis, titles, genres, airing information, studios, and dates.
- Add anime to your list, then choose a status and personal rating in its details.
- Use the plus/minus controls to record watched episodes. Progress stays within known episode counts. Reaching the final episode marks an anime Completed; decreasing completed progress returns it to Watching. Selecting Completed fills known episode counts.
- Filter and sort My Anime. Sort preference is saved.
- Choose “What should I watch?” on Home and select Watching, Plan to Watch, or both. “Watch this” marks the chosen anime Watching and opens its details.
- Remove anime through its details, with confirmation.
- Home shelves and statistics reflect your own library. There is no seeded or fake library.

Your library, ratings, progress, dates, and preferences are stored locally in your browser. Different devices, browsers, profiles, or addresses have separate libraries. Clearing site storage deletes the saved list. Storage failures display a notification rather than silently claiming changes were saved. Changes also synchronize between tabs on the same origin.

## Files and code organization

- `index.html` — semantic page structure, navigation, shelves, and native dialogs.
- `style.css` — midnight visual identity, responsive layouts, focus states, loading states, and reduced-motion support.
- `script.js` — configuration, storage, API requests, rendering, library updates, modal controls, random selection, and event handling. Comments mark these sections.

`requestAniList()` handles HTTP/GraphQL failures and a 20-second timeout. `searchAnime()` handles paging and ignores stale responses. `loadHomeDiscovery()` fetches genuine trending anime for the spotlight and discovery shelf. `fetchAnimeDetails()` retrieves uncached details.

`addAnimeToLibrary()`, `removeAnimeFromLibrary()`, `updateAnimeStatus()`, `updateEpisodeProgress()`, and `updatePersonalRating()` change the single in-memory library, persist it immediately, and call `refreshLibraryViews()`. `filterLibrary()` produces the selected sorted shelf. `getStatistics()` computes metrics from local records. `chooseRandomAnime()` chooses only saved anime in the selected statuses.

Each stored anime includes its AniList metadata plus `airingStatus`, personal `status`, `watchedEpisodes`, `personalRating` (0 means unrated), and `dateAdded`. The airing status and personal status are deliberately separate.

External text is escaped before rendering. Descriptions are converted to plain text and image URLs are restricted to HTTPS. Native HTML dialogs provide keyboard focus trapping and Escape-to-close behavior.

To rename the app, replace the visible YomiList/yomilist brand text in `index.html`. Keep the storage keys in `script.js` unchanged to retain an existing library.

## Data source

[AniList GraphQL API](https://docs.anilist.co/) supplies anime data and linked artwork. AniList may rate limit requests; the app displays a retryable error state. No streaming playback is included: “Watch this” starts tracking the selected story.

## Verification

Verified in Chromium against live AniList data: search (including Re:Zero), details, duplicate prevention, adding/removing with confirmation, all statuses and filters, all six sorting modes, ratings, progress limits and completion, accurate statistics, random selection and empty states, localStorage restoration after refresh, and graceful API connection failures. Checked page and modal layouts at 360, 390, 768, 1024, and 1440 pixels. Browser tests reported no uncaught JavaScript errors. Test tooling was kept outside this dependency-free project.
