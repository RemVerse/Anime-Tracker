"use strict";

// Configuration and application state. No account or API key is needed.
const API_URL = "https://graphql.anilist.co";
const STORAGE_KEY = "yomilist.library.v1";
const PREFERENCES_KEY = "yomilist.preferences.v1";
const STATUSES = [
  "Watching",
  "Completed",
  "Plan to Watch",
  "On Hold",
  "Dropped",
];
const MEDIA_FIELDS = `id title { romaji english native } coverImage { extraLarge large color }
  bannerImage description episodes duration genres averageScore popularity season seasonYear
  status format studios(isMain: true) { nodes { name } } startDate { year month day }
  endDate { year month day }`;
const $ = (selector) => document.querySelector(selector);
let library = loadLibrary();
let preferences = loadPreferences();
let libraryFilter = "All";
let discoverySort = "TRENDING_DESC";
let discoveryPage = 1;
let discoveryItems = [];
let searchTerm = "";
let discoveryRequest = 0;
let detailRequest = 0;
let featuredAnime = null;
let selectedAnime = null;
let pendingRemoval = null;
let searchTimer;
const animeCache = new Map(library.map((anime) => [anime.id, anime]));

// Storage: validate saved records and handle unavailable or full browser storage.
function loadLibrary() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(saved)) throw new Error("Invalid library");
    const seenIds = new Set();
    return saved
      .filter((anime) => {
        if (
          !anime ||
          !Number.isInteger(anime.id) ||
          !anime.title ||
          seenIds.has(anime.id)
        )
          return false;
        seenIds.add(anime.id);
        return true;
      })
      .map((anime) => ({
        ...anime,
        genres: Array.isArray(anime.genres) ? anime.genres : [],
        status: STATUSES.includes(anime.status)
          ? anime.status
          : "Plan to Watch",
        watchedEpisodes: Math.min(
          Math.max(0, Math.floor(Number(anime.watchedEpisodes) || 0)),
          anime.episodes || Infinity,
        ),
        personalRating: Math.min(
          10,
          Math.max(0, Math.floor(Number(anime.personalRating) || 0)),
        ),
      }));
  } catch {
    setTimeout(
      () =>
        showToast(
          "Your saved library could not be read. Browser storage may be unavailable.",
          true,
        ),
      0,
    );
    return [];
  }
}

function loadPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFERENCES_KEY) || "{}");
    return saved && typeof saved === "object" ? saved : {};
  } catch {
    return {};
  }
}

function saveLibrary() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(library));
  } catch {
    showToast(
      "Changes are in memory, but could not be saved. Check browser storage space.",
      true,
    );
  }
}

function savePreferences() {
  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    showToast("Your preferences could not be saved.", true);
  }
}

// API requests use a timeout and surface GraphQL and HTTP failures to the UI.
async function requestAniList(query, variables) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 429)
        throw new Error("AniList is busy. Please wait a minute and try again.");
      throw new Error(
        `AniList could not respond (${response.status}). Please try again.`,
      );
    }
    const result = await response.json();
    if (result.errors?.length) throw new Error(result.errors[0].message);
    if (!result.data) throw new Error("AniList returned an empty response.");
    return result.data;
  } catch (error) {
    if (error.name === "AbortError")
      throw new Error("The request timed out. Please try again.");
    if (error instanceof TypeError)
      throw new Error(
        "Unable to connect to AniList. Check your connection and try again.",
      );
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function searchAnime(append = false) {
  const requestId = ++discoveryRequest;
  const grid = $("#discover-grid");
  const page = append ? discoveryPage + 1 : 1;
  if (!append) grid.innerHTML = skeletonCards(12);
  $("#load-more").disabled = true;
  $("#load-more").hidden = true;
  $("#discover-subtitle").textContent = searchTerm
    ? `Search results for “${searchTerm}”`
    : "The stories everyone is talking about. Your next favorite is here.";
  $("#clear-search").hidden = !searchTerm;
  $("#discover-tabs").hidden = Boolean(searchTerm);
  try {
    const query = `query ($search: String, $sort: [MediaSort], $page: Int) {
      Page(page: $page, perPage: 18) {
        pageInfo { hasNextPage }
        media(type: ANIME, isAdult: false, search: $search, sort: $sort) { ${MEDIA_FIELDS} }
      }
    }`;
    const data = await requestAniList(query, {
      search: searchTerm || null,
      sort: searchTerm ? ["SEARCH_MATCH"] : [discoverySort],
      page,
    });
    if (requestId !== discoveryRequest) return;
    discoveryPage = page;
    discoveryItems = append
      ? [...discoveryItems, ...data.Page.media]
      : data.Page.media;
    discoveryItems.forEach((anime) => animeCache.set(anime.id, anime));
    grid.innerHTML = discoveryItems.length
      ? discoveryItems.map((anime) => animeCard(anime)).join("")
      : emptyState(
          "No stories found",
          "Try another title, its Romaji name, or a shorter search.",
          "Clear search",
          "clear-search",
        );
    $("#load-more").hidden = !data.Page.pageInfo.hasNextPage;
  } catch (error) {
    if (requestId !== discoveryRequest) return;
    if (append) {
      showToast(error.message, true);
      $("#load-more").hidden = false;
    } else grid.innerHTML = errorState(error.message, "retry-discover");
  } finally {
    if (requestId === discoveryRequest) $("#load-more").disabled = false;
  }
}

async function loadHomeDiscovery() {
  $("#home-discover-grid").innerHTML = skeletonCards(6);
  try {
    const data = await requestAniList(
      `query { Page(perPage: 12) {
      media(type: ANIME, isAdult: false, sort: TRENDING_DESC) { ${MEDIA_FIELDS} }
    } }`,
      {},
    );
    const anime = data.Page.media;
    anime.forEach((item) => animeCache.set(item.id, item));
    $("#home-discover-grid").innerHTML = anime
      .slice(0, 6)
      .map((item) => animeCard(item))
      .join("");
    featuredAnime = anime.find((item) => item.bannerImage) || anime[0];
    renderHero();
  } catch (error) {
    $("#home-discover-grid").innerHTML = errorState(
      error.message,
      "retry-home",
    );
  }
}

async function fetchAnimeDetails(id) {
  const data = await requestAniList(
    `query ($id: Int) { Media(id: $id, type: ANIME) { ${MEDIA_FIELDS} } }`,
    { id },
  );
  if (!data.Media) throw new Error("This anime could not be found.");
  animeCache.set(id, data.Media);
  return data.Media;
}

// Text from external sources is escaped. AniList descriptions are rendered as text.
function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
}
function cleanDescription(description) {
  const document = new DOMParser().parseFromString(
    description || "",
    "text/html",
  );
  document.querySelectorAll("script,style").forEach((node) => node.remove());
  document.querySelectorAll("br").forEach((node) => node.replaceWith("\n"));
  return (
    document.body.textContent.trim() ||
    "A synopsis is not available for this anime yet."
  );
}
function animeTitle(anime) {
  return (
    anime.title?.english ||
    anime.title?.romaji ||
    anime.title?.native ||
    "Untitled anime"
  );
}
function safeImage(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.href : "";
  } catch {
    return "";
  }
}
function formatLabel(value) {
  return value
    ? value
        .replaceAll("_", " ")
        .toLowerCase()
        .replace(/\b\w/g, (letter) => letter.toUpperCase())
    : "Unknown";
}
function animeFormat(value) {
  return ["TV", "OVA", "ONA"].includes(value) ? value : formatLabel(value);
}
function formatDate(date) {
  return date?.year
    ? [
        date.year,
        date.month ? String(date.month).padStart(2, "0") : null,
        date.day ? String(date.day).padStart(2, "0") : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "Not announced";
}
function coverImage(anime, className = "") {
  const source = safeImage(
    anime.coverImage?.extraLarge || anime.coverImage?.large,
  );
  return source
    ? `<img class="${className}" src="${escapeHtml(source)}" alt="${escapeHtml(animeTitle(anime))} cover" loading="lazy">`
    : `<div class="${className} image-fallback" role="img" aria-label="Cover unavailable"></div>`;
}
function skeletonCards(count) {
  return Array.from(
    { length: count },
    () => '<div class="skeleton" aria-hidden="true"></div>',
  ).join("");
}
function emptyState(
  title,
  description,
  buttonLabel = "Discover anime",
  action = "discover",
) {
  return `<div class="empty-state"><div class="empty-icon" aria-hidden="true">✧</div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p><button class="secondary" data-action="${action}">${escapeHtml(buttonLabel)}</button></div>`;
}
function errorState(message, action) {
  return emptyState("A brief intermission", message, "Try again ↻", action);
}

function animeCard(anime) {
  const saved = library.find((item) => item.id === anime.id);
  const title = escapeHtml(animeTitle(anime));
  const score = anime.averageScore ? (anime.averageScore / 10).toFixed(1) : "—";
  const progress =
    saved && anime.episodes
      ? Math.min(100, (saved.watchedEpisodes / anime.episodes) * 100)
      : 0;
  return `<article class="anime-card">
    <button class="cover-button" data-detail="${anime.id}" aria-label="View ${title}">
      ${coverImage(anime)}<span class="card-score">★ ${score}</span>
      ${saved ? `<span class="card-badge">${escapeHtml(saved.status)}</span>` : ""}
    </button>
    <button class="card-title" data-detail="${anime.id}">${title}</button>
    <p class="card-meta">${anime.seasonYear || "TBA"} · ${animeFormat(anime.format)} · ${anime.episodes ? `${anime.episodes} episodes` : "Episodes TBA"}${saved?.personalRating ? ` · ♥ ${saved.personalRating}/10` : ""}</p>
    ${saved ? `<div class="progress-row"><span>${saved.watchedEpisodes} / ${anime.episodes || "?"} eps</span><button data-progress="${anime.id}" data-change="-1" aria-label="Subtract an episode for ${title}" ${saved.watchedEpisodes === 0 ? "disabled" : ""}>−</button><button data-progress="${anime.id}" data-change="1" aria-label="Add an episode for ${title}" ${anime.episodes && saved.watchedEpisodes >= anime.episodes ? "disabled" : ""}>＋</button></div><div class="progress-track"><span style="width:${progress}%"></span></div>` : `<p class="card-genres">${escapeHtml((anime.genres || []).slice(0, 2).join(" · "))}</p>`}
  </article>`;
}

function renderHero() {
  const anime =
    library.find((item) => item.status === "Watching" && item.bannerImage) ||
    featuredAnime;
  if (!anime) return;
  const banner = safeImage(anime.bannerImage);
  $("#hero-art").style.backgroundImage = banner
    ? `url("${banner.replaceAll('"', "%22")}")`
    : "";
  $("#hero-title").textContent = animeTitle(anime);
  $("#hero-description").textContent = cleanDescription(anime.description);
  $("#hero-season").textContent =
    `${formatLabel(anime.season)} ${anime.seasonYear || ""}`;
  $("#hero-meta").innerHTML =
    `<span class="score">★ ${anime.averageScore ? (anime.averageScore / 10).toFixed(1) : "—"}</span><span>${animeFormat(anime.format)}</span><span>${anime.episodes || "?"} episodes</span><span>${escapeHtml(anime.genres?.slice(0, 2).join(" · "))}</span>`;
  $("#hero-open").innerHTML = "Explore this story <span>↗</span>";
  $("#hero-open").dataset.id = anime.id;
  $("#hero-add").hidden = false;
  $("#hero-add").dataset.id = anime.id;
  $("#hero-add").textContent = library.some((item) => item.id === anime.id)
    ? "✓ In your list"
    : "＋ My list";
}

// Library mutations always save immediately, then refresh the dependent UI.
function addAnimeToLibrary(anime, status = "Plan to Watch") {
  if (library.some((item) => item.id === anime.id)) {
    showToast("This story is already in your library.");
    return;
  }
  library.unshift({
    ...anime,
    airingStatus: anime.status,
    status,
    watchedEpisodes: 0,
    personalRating: 0,
    dateAdded: new Date().toISOString(),
  });
  saveLibrary();
  refreshLibraryViews();
  showToast(`${animeTitle(anime)} added to your library.`);
}
function removeAnimeFromLibrary(id) {
  library = library.filter((item) => item.id !== id);
  saveLibrary();
  refreshLibraryViews();
  showToast("Anime removed from your library.");
}
function updateEpisodeProgress(id, change) {
  const anime = library.find((item) => item.id === id);
  if (!anime) return;
  const previous = anime.watchedEpisodes;
  anime.watchedEpisodes = Math.min(
    Math.max(0, previous + change),
    anime.episodes || Infinity,
  );
  if (
    anime.episodes &&
    anime.watchedEpisodes === anime.episodes &&
    previous < anime.episodes
  ) {
    anime.status = "Completed";
    showToast("All episodes watched. Story completed!");
  } else if (change < 0 && anime.status === "Completed")
    anime.status = "Watching";
  saveLibrary();
  refreshLibraryViews();
}
function updateAnimeStatus(id, status) {
  const anime = library.find((item) => item.id === id);
  if (!anime || !STATUSES.includes(status)) return;
  anime.status = status;
  if (status === "Completed" && anime.episodes)
    anime.watchedEpisodes = anime.episodes;
  saveLibrary();
  refreshLibraryViews();
  showToast(`Moved to ${status}.`);
}
function updatePersonalRating(id, rating) {
  const anime = library.find((item) => item.id === id);
  if (!anime) return;
  anime.personalRating = Math.min(
    10,
    Math.max(0, Math.floor(Number(rating) || 0)),
  );
  saveLibrary();
  refreshLibraryViews();
  showToast("Personal rating updated.");
}
function filterLibrary() {
  const filtered = library.filter(
    (anime) => libraryFilter === "All" || anime.status === libraryFilter,
  );
  const sort = $("#sort-select").value;
  return filtered.sort((a, b) => {
    if (sort === "title") return animeTitle(a).localeCompare(animeTitle(b));
    if (sort === "rating") return b.personalRating - a.personalRating;
    if (sort === "score") return (b.averageScore || 0) - (a.averageScore || 0);
    if (sort === "progress") return b.watchedEpisodes - a.watchedEpisodes;
    if (sort === "year") return (b.seasonYear || 0) - (a.seasonYear || 0);
    return new Date(b.dateAdded || 0) - new Date(a.dateAdded || 0);
  });
}
function renderLibrary() {
  $("#status-filters").innerHTML = ["All", ...STATUSES]
    .map(
      (status) =>
        `<button data-filter="${status}" class="${status === libraryFilter ? "active" : ""}" aria-pressed="${status === libraryFilter}">${status} <span>${status === "All" ? library.length : library.filter((anime) => anime.status === status).length}</span></button>`,
    )
    .join("");
  const filtered = filterLibrary();
  $("#library-grid").innerHTML = filtered.length
    ? filtered.map(animeCard).join("")
    : emptyState(
        library.length
          ? "An empty shelf, for now"
          : "Your story collection starts here",
        library.length
          ? `You don't have any anime marked ${libraryFilter.toLowerCase()} yet.`
          : "Discover something you love and add it to your library. Every great journey starts with one anime.",
      );
}
function getStatistics() {
  const rated = library.filter((anime) => anime.personalRating > 0);
  const genreCounts = {};
  library.forEach((anime) =>
    anime.genres.forEach((genre) => {
      genreCounts[genre] = (genreCounts[genre] || 0) + 1;
    }),
  );
  const completed = library.filter(
    (anime) => anime.status === "Completed",
  ).length;
  return {
    total: library.length,
    watching: library.filter((anime) => anime.status === "Watching").length,
    completed,
    dropped: library.filter((anime) => anime.status === "Dropped").length,
    episodes: library.reduce((sum, anime) => sum + anime.watchedEpisodes, 0),
    average: rated.length
      ? (
          rated.reduce((sum, anime) => sum + anime.personalRating, 0) /
          rated.length
        ).toFixed(1)
      : "—",
    genre:
      Object.keys(genreCounts).sort(
        (a, b) => genreCounts[b] - genreCounts[a],
      )[0] || "To be discovered",
    completion: library.length
      ? Math.round((completed / library.length) * 100)
      : 0,
  };
}
function renderStatistics() {
  const stats = getStatistics();
  const metrics = [
    ["▷", stats.watching, "Currently watching"],
    ["✓", stats.completed, "Stories completed"],
    ["▤", stats.episodes.toLocaleString(), "Episodes watched"],
    ["☆", stats.average, "Average personal score"],
  ];
  $("#stats-strip").innerHTML = metrics
    .map(
      ([icon, value, label]) =>
        `<div class="stat"><div class="stat-icon" aria-hidden="true">${icon}</div><div><strong>${value}</strong><p>${label}</p></div></div>`,
    )
    .join("");
  $("#journey-stats").innerHTML = [
    ["Anime in your library", stats.total],
    ["Stories completed", stats.completed],
    ["Dropped", stats.dropped],
    ["Your favorite genre", stats.genre],
  ]
    .map(
      ([label, value]) =>
        `<div class="journey-row"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`,
    )
    .join("");
  $("#completion-bar").style.width = `${stats.completion}%`;
  $("#completion-label").textContent =
    `${stats.completion}% of your library completed`;
  $("#nav-count").textContent = library.length;
  $("#watching-count").textContent = stats.watching;
}
function renderHomeLibrary() {
  const watching = library
    .filter((anime) => anime.status === "Watching")
    .slice(0, 4);
  const planned = library
    .filter((anime) => anime.status === "Plan to Watch")
    .slice(0, 4);
  const recent = [...library]
    .sort((a, b) => new Date(b.dateAdded) - new Date(a.dateAdded))
    .slice(0, 6);
  $("#continue-grid").innerHTML = watching.length
    ? watching.map(animeCard).join("")
    : emptyState(
        "Ready for your first episode?",
        "Add an anime and set it to Watching to pick up your journey here.",
      );
  $("#planned-grid").innerHTML = planned.length
    ? planned.map(animeCard).join("")
    : emptyState(
        "Good stories are worth saving",
        "Build your watchlist now. Find your next adventure when the mood strikes.",
      );
  $("#recent-grid").innerHTML = recent.length
    ? recent.map(animeCard).join("")
    : emptyState(
        "Make room for your favorites",
        "Your recently saved anime will appear here.",
      );
}
function refreshLibraryViews() {
  renderLibrary();
  renderHomeLibrary();
  renderStatistics();
  renderHero();
  if ($("#detail-dialog").open && selectedAnime)
    renderAnimeDetails(selectedAnime);
  if (discoveryItems.length)
    $("#discover-grid").innerHTML = discoveryItems.map(animeCard).join("");
  const homeCards = [
    ...$("#home-discover-grid").querySelectorAll(".cover-button"),
  ]
    .map((button) => animeCache.get(Number(button.dataset.detail)))
    .filter(Boolean);
  if (homeCards.length)
    $("#home-discover-grid").innerHTML = homeCards.map(animeCard).join("");
}

// Native dialogs provide focus trapping, keyboard navigation, and Escape support.
function openDialog(id) {
  const dialog = $(`#${id}`);
  if (!dialog.open) dialog.showModal();
  document.body.style.overflow = "hidden";
}
async function openAnimeDetails(id) {
  const requestId = ++detailRequest;
  selectedAnime =
    animeCache.get(id) || library.find((anime) => anime.id === id);
  if (selectedAnime) renderAnimeDetails(selectedAnime);
  else
    $("#detail-content").innerHTML =
      '<div style="padding:70px 35px" role="status">Opening your next story…</div>';
  openDialog("detail-dialog");
  if (selectedAnime) return;
  try {
    const anime = await fetchAnimeDetails(id);
    if (requestId !== detailRequest || !$("#detail-dialog").open) return;
    selectedAnime = anime;
    renderAnimeDetails(anime);
  } catch (error) {
    if (requestId === detailRequest)
      $("#detail-content").innerHTML =
        `<div style="padding:65px 30px">${errorState(error.message, "retry-detail")}<button hidden id="retry-detail-id" data-id="${id}"></button></div>`;
  }
}
function renderAnimeDetails(anime) {
  const saved = library.find((item) => item.id === anime.id);
  const banner = safeImage(anime.bannerImage);
  const airingStatus =
    saved?.airingStatus || anime.airingStatus || anime.status;
  const metadata = [
    [
      "AniList score",
      anime.averageScore ? `${anime.averageScore}%` : "Not rated",
    ],
    ["Popularity", anime.popularity?.toLocaleString() || "—"],
    ["Episodes", anime.episodes || "Not announced"],
    [
      "Episode length",
      anime.duration ? `${anime.duration} minutes` : "Unknown",
    ],
    ["Format", animeFormat(anime.format)],
    ["Season", `${formatLabel(anime.season)} ${anime.seasonYear || ""}`],
    ["Airing status", formatLabel(airingStatus)],
    [
      "Studio",
      anime.studios?.nodes?.map((studio) => studio.name).join(", ") ||
        "Not announced",
    ],
    ["Start date", formatDate(anime.startDate)],
    ["End date", formatDate(anime.endDate)],
  ];
  $("#detail-content").innerHTML =
    `<div class="detail-banner" id="detail-banner"></div><div class="detail-body">
    <div class="detail-side">${coverImage(anime, "detail-cover")}${!saved ? `<button class="primary" data-add="${anime.id}">＋ Add to My List</button>` : ""}</div>
    <div class="detail-main"><span class="eyebrow">${saved ? "A STORY IN YOUR LIBRARY" : "YOUR NEXT CHAPTER"}</span><h2>${escapeHtml(animeTitle(anime))}</h2>
    <p class="alt-title">${escapeHtml(anime.title.romaji || "")}<br>${escapeHtml(anime.title.native || "")}</p>
    <div class="genre-tags">${(anime.genres || []).map((genre) => `<span>${escapeHtml(genre)}</span>`).join("")}</div>
    ${saved ? renderListControls(saved) : ""}
    <p class="description">${escapeHtml(cleanDescription(anime.description))}</p>
    <dl class="metadata">${metadata.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>
    <a class="text-button" href="https://anilist.co/anime/${anime.id}" target="_blank" rel="noopener">View on AniList ↗</a></div></div>`;
  $("#detail-banner").style.backgroundImage = banner
    ? `url("${banner.replaceAll('"', "%22")}")`
    : "";
}
function renderListControls(anime) {
  return `<div class="list-controls"><div class="control-fields"><div><label for="detail-status">Your status</label><select id="detail-status" data-status-id="${anime.id}">${STATUSES.map((status) => `<option ${status === anime.status ? "selected" : ""}>${status}</option>`).join("")}</select></div><div><label for="detail-rating">Personal rating</label><select id="detail-rating" data-rating-id="${anime.id}"><option value="0">Not rated</option>${Array.from({ length: 10 }, (_, index) => `<option value="${index + 1}" ${anime.personalRating === index + 1 ? "selected" : ""}>${index + 1} / 10</option>`).join("")}</select></div></div><div class="detail-progress"><button data-progress="${anime.id}" data-change="-1" aria-label="Subtract one watched episode" ${anime.watchedEpisodes === 0 ? "disabled" : ""}>−</button><strong>${anime.watchedEpisodes} / ${anime.episodes || "?"} episodes</strong><button data-progress="${anime.id}" data-change="1" aria-label="Add one watched episode" ${anime.episodes && anime.watchedEpisodes >= anime.episodes ? "disabled" : ""}>＋</button></div><button class="remove-button" data-remove="${anime.id}">Remove from my library</button></div>`;
}

// Random selection only uses the user's eligible saved anime.
function chooseRandomAnime() {
  const statuses = [];
  if ($("#random-watching").checked) statuses.push("Watching");
  if ($("#random-planned").checked) statuses.push("Plan to Watch");
  preferences.randomWatching = $("#random-watching").checked;
  preferences.randomPlanned = $("#random-planned").checked;
  savePreferences();
  const candidates = library.filter((anime) => statuses.includes(anime.status));
  const result = $("#random-result");
  if (!candidates.length) {
    result.innerHTML = `<p>${statuses.length ? "No anime on these shelves yet. Add a story to Watching or Plan to Watch first." : "Choose at least one shelf above."}</p>`;
    return;
  }
  const anime = candidates[Math.floor(Math.random() * candidates.length)];
  result.classList.remove("reveal");
  result.innerHTML = `${coverImage(anime)}<h3>${escapeHtml(animeTitle(anime))}</h3><p>${escapeHtml(anime.genres.join(" · "))}</p><p>${anime.episodes || "?"} episodes · ★ ${anime.averageScore ? (anime.averageScore / 10).toFixed(1) : "—"}</p><button class="secondary" data-watch="${anime.id}">Watch this →</button>`;
  void result.offsetWidth;
  result.classList.add("reveal");
  $("#random-roll").textContent = "Pick another story ↻";
}
function showToast(message, error = false) {
  const toast = document.createElement("div");
  toast.className = `toast${error ? " error" : ""}`;
  toast.textContent = message;
  $("#toasts").append(toast);
  setTimeout(() => toast.remove(), 4500);
}

// Navigation and event handling are delegated so refreshed cards keep working.
function navigate() {
  const requested = location.hash.slice(1);
  const page = ["home", "library", "discover"].includes(requested)
    ? requested
    : "home";
  document.querySelectorAll(".page").forEach((section) => {
    section.hidden = section.id !== `${page}-page`;
  });
  document.querySelectorAll("[data-page]").forEach((link) => {
    link.classList.toggle("active", link.dataset.page === page);
    if (link.dataset.page === page) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  if (page === "discover" && !discoveryItems.length) searchAnime();
  window.scrollTo({ top: 0, behavior: "instant" });
}
function submitSearch() {
  clearTimeout(searchTimer);
  searchTerm = $("#search-input").value.trim().slice(0, 200);
  if (location.hash !== "#discover") {
    // Invalidate any previous query and let navigation avoid issuing a second request.
    discoveryItems = [];
    location.hash = "discover";
  } else searchAnime();
}
function restoreControlFocus(attribute, id) {
  const control = document.querySelector(
    `#detail-dialog [${attribute}="${id}"]`,
  );
  if (control) control.focus();
}
document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.close) $(`#${button.dataset.close}`).close();
  if (button.dataset.detail) openAnimeDetails(Number(button.dataset.detail));
  if (button.dataset.add) {
    const anime = animeCache.get(Number(button.dataset.add));
    if (anime) addAnimeToLibrary(anime);
    restoreControlFocus("data-status-id", button.dataset.add);
  }
  if (button.dataset.progress) {
    const inDialog = Boolean(button.closest("#detail-dialog"));
    const shelfId = button.closest("[id]")?.id;
    const id = button.dataset.progress;
    const change = button.dataset.change;
    updateEpisodeProgress(Number(id), Number(change));
    if (inDialog) {
      const control = document.querySelector(
        `#detail-dialog [data-progress="${id}"][data-change="${change}"]:not(:disabled)`,
      );
      (control || $("#detail-status"))?.focus();
    } else if (shelfId) {
      const shelf = document.getElementById(shelfId);
      const control = shelf?.querySelector(
        `[data-progress="${id}"][data-change="${change}"]:not(:disabled)`,
      );
      (control || shelf?.querySelector(`[data-detail="${id}"]`))?.focus();
    }
  }
  if (button.dataset.filter) {
    libraryFilter = button.dataset.filter;
    renderLibrary();
    $(`[data-filter="${libraryFilter}"]`).focus();
  }
  if (button.dataset.sort) {
    discoverySort = button.dataset.sort;
    document
      .querySelectorAll("[data-sort]")
      .forEach((tab) => tab.classList.toggle("active", tab === button));
    searchAnime();
  }
  if (button.dataset.remove) {
    pendingRemoval = Number(button.dataset.remove);
    const anime = library.find((item) => item.id === pendingRemoval);
    $("#confirm-description").textContent =
      `${animeTitle(anime)} and its progress and rating will be removed from this browser's library.`;
    openDialog("confirm-dialog");
  }
  if (button.dataset.watch) {
    const id = Number(button.dataset.watch);
    updateAnimeStatus(id, "Watching");
    $("#random-dialog").close();
    openAnimeDetails(id);
  }
  const action = button.dataset.action;
  if (action === "discover") location.hash = "discover";
  if (action === "retry-home") loadHomeDiscovery();
  if (action === "retry-discover") searchAnime();
  if (action === "retry-detail")
    openAnimeDetails(Number($("#retry-detail-id").dataset.id));
  if (action === "clear-search") clearSearch();
});
document.addEventListener("change", (event) => {
  const control = event.target;
  if (control.dataset.statusId) {
    updateAnimeStatus(Number(control.dataset.statusId), control.value);
    restoreControlFocus("data-status-id", control.dataset.statusId);
  }
  if (control.dataset.ratingId) {
    updatePersonalRating(Number(control.dataset.ratingId), control.value);
    restoreControlFocus("data-rating-id", control.dataset.ratingId);
  }
});
function clearSearch() {
  clearTimeout(searchTimer);
  $("#search-input").value = "";
  searchTerm = "";
  searchAnime();
}
$("#search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  submitSearch();
});
$("#search-input").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(submitSearch, 550);
});
$("#clear-search").addEventListener("click", clearSearch);
$("#load-more").addEventListener("click", () => searchAnime(true));
$("#sort-select").addEventListener("change", () => {
  preferences.sort = $("#sort-select").value;
  savePreferences();
  renderLibrary();
});
$("#hero-open").addEventListener("click", () => {
  const id = Number($("#hero-open").dataset.id);
  if (id) openAnimeDetails(id);
  else location.hash = "discover";
});
$("#hero-add").addEventListener("click", () => {
  const id = Number($("#hero-add").dataset.id);
  if (library.some((item) => item.id === id)) openAnimeDetails(id);
  else {
    const anime = animeCache.get(id);
    if (anime) addAnimeToLibrary(anime);
  }
});
$("#profile-button").addEventListener("click", () => {
  location.hash = "home";
  requestAnimationFrame(() =>
    $("#journey-stats").scrollIntoView({ behavior: "smooth", block: "center" }),
  );
});
$("#random-open").addEventListener("click", () => {
  $("#random-result").innerHTML = "";
  $("#random-roll").textContent = "Find my next anime ⚄";
  openDialog("random-dialog");
});
$("#random-roll").addEventListener("click", chooseRandomAnime);
$("#confirm-remove").addEventListener("click", () => {
  removeAnimeFromLibrary(pendingRemoval);
  pendingRemoval = null;
  $("#confirm-dialog").close();
  $("#detail-dialog").querySelector("[data-add]")?.focus();
});
document.querySelectorAll("dialog").forEach((dialog) => {
  dialog.addEventListener("close", () => {
    if (!document.querySelector("dialog[open]"))
      document.body.style.overflow = "";
    if (dialog.id === "detail-dialog") detailRequest++;
  });
  dialog.addEventListener("click", (event) => {
    const rectangle = dialog.getBoundingClientRect();
    if (
      event.target === dialog &&
      (event.clientX < rectangle.left ||
        event.clientX > rectangle.right ||
        event.clientY < rectangle.top ||
        event.clientY > rectangle.bottom)
    )
      dialog.close();
  });
});
// Missing remote artwork keeps its space and a readable fallback label.
document.addEventListener(
  "error",
  (event) => {
    if (event.target.tagName === "IMG") {
      event.target.classList.add("image-fallback");
      event.target.alt = "Cover unavailable";
    }
  },
  true,
);
document.addEventListener("keydown", (event) => {
  if (
    event.key === "/" &&
    !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName) &&
    !document.querySelector("dialog[open]")
  ) {
    event.preventDefault();
    $("#search-input").focus();
  }
});
window.addEventListener("hashchange", navigate);
window.addEventListener("storage", (event) => {
  if (event.key === STORAGE_KEY) {
    library = loadLibrary();
    library.forEach((anime) => {
      if (!animeCache.has(anime.id)) animeCache.set(anime.id, anime);
    });
    refreshLibraryViews();
  }
});

// Start with only genuine user data. Discover content is fetched live from AniList.
if (
  [...$("#sort-select").options].some(
    (option) => option.value === preferences.sort,
  )
)
  $("#sort-select").value = preferences.sort;
$("#random-watching").checked = preferences.randomWatching !== false;
$("#random-planned").checked = preferences.randomPlanned !== false;
refreshLibraryViews();
navigate();
loadHomeDiscovery();
