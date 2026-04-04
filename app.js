const APPLICATION_STATUSES = [
  "Interested",
  "Applied",
  "Interview",
  "Accepted",
  "Waitlisted",
  "Rejected",
  "Attended",
];
const AWARD_TITLES = [
  "Best Delegate",
  "Outstanding Delegate",
  "Honorable Mention",
  "Best Position Paper",
  "Best First-Timer",
  "Verbal Commendation",
];
const EXPERIENCE_LEVELS = [
  "Beginner",
  "Intermediate",
  "Advanced",
  "Chair / Secretariat",
];

const dom = {
  runtimeBanner: document.getElementById("runtime-banner"),
  statsGrid: document.getElementById("stats-grid"),
  searchFilter: document.getElementById("search-filter"),
  cityFilter: document.getElementById("city-filter"),
  formatFilter: document.getElementById("format-filter"),
  levelFilter: document.getElementById("level-filter"),
  languageFilter: document.getElementById("language-filter"),
  fromDateFilter: document.getElementById("from-date-filter"),
  toDateFilter: document.getElementById("to-date-filter"),
  resetFilters: document.getElementById("reset-filters"),
  conferenceResults: document.getElementById("conference-results"),
  conferenceGrid: document.getElementById("conference-grid"),
  authShell: document.getElementById("auth-shell"),
  profileShell: document.getElementById("profile-shell"),
  applicationShell: document.getElementById("application-shell"),
  awardShell: document.getElementById("award-shell"),
  assistantShell: document.getElementById("assistant-shell"),
  guideShell: document.getElementById("guide-shell"),
  reviewShell: document.getElementById("review-shell"),
  messageShell: document.getElementById("message-shell"),
  statuses: {
    auth: document.getElementById("auth-status"),
    profile: document.getElementById("profile-status"),
    application: document.getElementById("application-status"),
    award: document.getElementById("award-status"),
    assistant: document.getElementById("assistant-status"),
    guide: document.getElementById("guide-status"),
    review: document.getElementById("review-status"),
    message: document.getElementById("message-status"),
  },
};

const state = {
  backendReady: false,
  backendMessage: "",
  me: null,
  conferences: [],
  guides: [],
  reviews: [],
  applications: [],
  awards: [],
  assistant: {
    resolution: "Generate a resolution outline to see it here.",
    speech: "Generate an opening speech draft to see it here.",
  },
  directory: [],
  messages: [],
  selectedUserId: null,
  directoryQuery: "",
  pendingConferenceId: "",
  filters: {
    search: "",
    city: "all",
    format: "all",
    level: "all",
    language: "all",
    fromDate: "",
    toDate: "",
  },
};

let messagePollHandle = null;

function getBackendHelpMessage() {
  if (window.location.protocol === "file:") {
    return "This server-backed build cannot run from a direct file preview. Run node server.js or open start-mun-turkey.cmd, then browse to http://localhost:3000.";
  }

  return "The backend is not responding. Run node server.js or open start-mun-turkey.cmd, then refresh this page at http://localhost:3000.";
}

function escapeHTML(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function emptyState(title, body) {
  return `
    <div class="empty-state">
      <h3>${escapeHTML(title)}</h3>
      <p>${escapeHTML(body)}</p>
    </div>
  `;
}

function pluralize(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatDate(dateString, options) {
  return new Intl.DateTimeFormat("en-GB", options).format(new Date(dateString));
}

function formatDateRange(startDate, endDate) {
  return `${formatDate(startDate, {
    day: "numeric",
    month: "short",
    year: "numeric",
  })} - ${formatDate(endDate, {
    day: "numeric",
    month: "short",
    year: "numeric",
  })}`;
}

function formatShortDate(dateString) {
  return formatDate(dateString, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatDateTime(dateString) {
  return formatDate(dateString, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function buildStars(rating) {
  return `Rating ${rating}/5`;
}

function setStatus(section, message, tone = "neutral") {
  const element = dom.statuses[section];
  if (!element) {
    return;
  }

  element.textContent = message;
  if (message) {
    element.dataset.tone = tone;
  } else {
    delete element.dataset.tone;
  }
}

function clearStatuses() {
  Object.keys(dom.statuses).forEach((key) => setStatus(key, ""));
}

function renderRuntimeBanner() {
  if (!dom.runtimeBanner) {
    return;
  }

  if (!state.backendMessage) {
    dom.runtimeBanner.hidden = true;
    dom.runtimeBanner.textContent = "";
    delete dom.runtimeBanner.dataset.tone;
    return;
  }

  dom.runtimeBanner.hidden = false;
  dom.runtimeBanner.textContent = state.backendMessage;
  dom.runtimeBanner.dataset.tone = state.backendReady ? "neutral" : "error";
}

async function apiRequest(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      ...options,
    });
  } catch (error) {
    throw new Error(getBackendHelpMessage());
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || "Request failed.");
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

function getConferenceById(conferenceId) {
  return state.conferences.find((conference) => conference.id === conferenceId) || null;
}

function getUserById(userId) {
  return state.directory.find((user) => user.id === userId) || null;
}

function committeeListMarkup(items, emptyCopy) {
  if (!items.length) {
    return `<div class="meta-item"><small>${escapeHTML(emptyCopy)}</small></div>`;
  }

  return items
    .map(
      (item) => `
        <div class="committee-item">
          <strong>${escapeHTML(item.name)}</strong>
          <small>${escapeHTML(item.topic || "Topic not listed on the public record.")}</small>
        </div>
      `,
    )
    .join("");
}

function buildConferenceOptions(selectedId = "") {
  return state.conferences
    .map(
      (conference) => `
        <option value="${escapeHTML(conference.id)}" ${
          conference.id === selectedId ? "selected" : ""
        }>
          ${escapeHTML(conference.shortName)} | ${escapeHTML(conference.city)}
        </option>
      `,
    )
    .join("");
}

function hydrateFilters() {
  const cities = [...new Set(state.conferences.map((conference) => conference.city))].sort();
  const levels = [
    ...new Set(state.conferences.flatMap((conference) => conference.educationLevels)),
  ].sort();
  const languages = [...new Set(state.conferences.map((conference) => conference.language))].sort();

  dom.cityFilter.innerHTML = `<option value="all">All cities</option>${cities
    .map((city) => `<option value="${escapeHTML(city)}">${escapeHTML(city)}</option>`)
    .join("")}`;
  dom.levelFilter.innerHTML = `<option value="all">All levels</option>${levels
    .map((level) => `<option value="${escapeHTML(level)}">${escapeHTML(level)}</option>`)
    .join("")}`;
  dom.languageFilter.innerHTML = `<option value="all">All languages</option>${languages
    .map((language) => `<option value="${escapeHTML(language)}">${escapeHTML(language)}</option>`)
    .join("")}`;

  dom.cityFilter.value = state.filters.city;
  dom.levelFilter.value = state.filters.level;
  dom.languageFilter.value = state.filters.language;
  dom.formatFilter.value = state.filters.format;
  dom.fromDateFilter.value = state.filters.fromDate;
  dom.toDateFilter.value = state.filters.toDate;
}

function getFilteredConferences() {
  const searchTerm = state.filters.search.trim().toLowerCase();

  return state.conferences.filter((conference) => {
    const matchesSearch =
      !searchTerm ||
      [
        conference.name,
        conference.shortName,
        conference.city,
        conference.description,
        conference.language,
        conference.fees,
        ...conference.committees.map((committee) => `${committee.name} ${committee.topic}`),
      ]
        .join(" ")
        .toLowerCase()
        .includes(searchTerm);

    const matchesCity = state.filters.city === "all" || conference.city === state.filters.city;
    const matchesFormat =
      state.filters.format === "all" || conference.formats.includes(state.filters.format);
    const matchesLevel =
      state.filters.level === "all" || conference.educationLevels.includes(state.filters.level);
    const matchesLanguage =
      state.filters.language === "all" || conference.language === state.filters.language;
    const matchesFromDate =
      !state.filters.fromDate || conference.startDate >= state.filters.fromDate;
    const matchesToDate = !state.filters.toDate || conference.endDate <= state.filters.toDate;

    return (
      matchesSearch &&
      matchesCity &&
      matchesFormat &&
      matchesLevel &&
      matchesLanguage &&
      matchesFromDate &&
      matchesToDate
    );
  });
}

function renderStats() {
  if (!state.backendReady) {
    dom.statsGrid.innerHTML = [
      {
        label: "Status",
        value: "Offline",
        copy: "Open the site through the local MUN Turkey server",
      },
      {
        label: "Start command",
        value: "node",
        copy: "Run node server.js or use the local launcher script",
      },
      {
        label: "Correct URL",
        value: "3000",
        copy: "Browse to http://localhost:3000 after starting the server",
      },
      {
        label: "Mode",
        value: "Real",
        copy: "This version loads live data and user sessions from the app server",
      },
    ]
      .map(
        (stat) => `
          <article class="stat-card">
            <span class="stat-label">${escapeHTML(stat.label)}</span>
            <strong class="stat-value">${escapeHTML(String(stat.value))}</strong>
            <span class="status-copy">${escapeHTML(stat.copy)}</span>
          </article>
        `,
      )
      .join("");
    return;
  }

  const cityCount = new Set(state.conferences.map((conference) => conference.city)).size;
  const jmunCount = state.conferences.filter((conference) =>
    conference.formats.includes("JMUN"),
  ).length;
  const reviewCount = state.reviews.length;

  dom.statsGrid.innerHTML = [
    {
      label: "Conferences",
      value: state.conferences.length,
      copy: "Verified public listings currently available to browse",
    },
    {
      label: "Cities",
      value: cityCount,
      copy: "Cities currently represented in the directory",
    },
    {
      label: "JMUN Tracks",
      value: jmunCount,
      copy: "Junior tracks currently visible in the listings",
    },
    {
      label: "Reviews",
      value: reviewCount,
      copy: "Delegate reviews available to read before you apply",
    },
  ]
    .map(
      (stat) => `
        <article class="stat-card">
          <span class="stat-label">${escapeHTML(stat.label)}</span>
          <strong class="stat-value">${escapeHTML(String(stat.value))}</strong>
          <span class="status-copy">${escapeHTML(stat.copy)}</span>
        </article>
      `,
    )
    .join("");
}

function buildConferenceCard(conference) {
  const buttons = [
    `<a class="button button-primary" href="${escapeHTML(
      conference.applicationLink,
    )}" target="_blank" rel="noreferrer">Application / Listing</a>`,
    `<a class="button button-secondary" href="${escapeHTML(
      conference.sourceUrl,
    )}" target="_blank" rel="noreferrer">Source</a>`,
  ];

  if (conference.officialUrl && conference.officialUrl !== conference.sourceUrl) {
    buttons.push(
      `<a class="button button-secondary" href="${escapeHTML(
        conference.officialUrl,
      )}" target="_blank" rel="noreferrer">Official site</a>`,
    );
  }

  buttons.push(
    `<button class="button button-secondary" type="button" data-track-conference="${escapeHTML(
      conference.id,
    )}">Track application</button>`,
  );

  return `
    <article class="conference-card">
      <div class="conference-head">
        <div>
          <h3>${escapeHTML(conference.shortName)}</h3>
          <p class="conference-title">${escapeHTML(conference.name)}</p>
        </div>
        <span class="source-chip">${escapeHTML(conference.sourceLabel)}</span>
      </div>

      <div class="chip-row">
        <span class="chip">${escapeHTML(conference.city)}</span>
        ${conference.formats
          .map((format) => `<span class="track-chip">${escapeHTML(format)}</span>`)
          .join("")}
        ${conference.educationLevels
          .map((level) => `<span class="status-chip">${escapeHTML(level)}</span>`)
          .join("")}
        ${
          conference.reviewCount
            ? `<span class="rating-chip">${escapeHTML(
                `${buildStars(conference.reviewAverage)} | ${pluralize(
                  conference.reviewCount,
                  "review",
                  "reviews",
                )}`,
              )}</span>`
            : ""
        }
      </div>

      <p>${escapeHTML(conference.description)}</p>

      <div class="meta-grid">
        <div class="meta-item">
          <strong>Conference dates</strong>
          <small>${escapeHTML(formatDateRange(conference.startDate, conference.endDate))}</small>
        </div>
        <div class="meta-item">
          <strong>Application window</strong>
          <small>${escapeHTML(formatShortDate(conference.applyStart))} - ${escapeHTML(
            formatShortDate(conference.applyEnd),
          )}</small>
        </div>
        <div class="meta-item">
          <strong>Language</strong>
          <small>${escapeHTML(conference.language)}</small>
        </div>
        <div class="meta-item">
          <strong>Fees</strong>
          <small>${escapeHTML(conference.fees)}</small>
        </div>
        <div class="meta-item">
          <strong>Committee count</strong>
          <small>${escapeHTML(String(conference.committeeCount || conference.committees.length))}</small>
        </div>
        <div class="meta-item">
          <strong>Verified</strong>
          <small>${escapeHTML(conference.lastVerified)}</small>
        </div>
      </div>

      <div class="committee-list">
        ${committeeListMarkup(
          conference.committees.slice(0, 6),
          "Committee details are not available on the public record yet.",
        )}
      </div>

      <div class="button-row">
        ${buttons.join("")}
      </div>
    </article>
  `;
}

function renderConferences() {
  if (!state.backendReady) {
    dom.conferenceResults.textContent = "Backend not connected.";
    dom.conferenceGrid.innerHTML = emptyState(
      "The real site needs the server running.",
      getBackendHelpMessage(),
    );
    return;
  }

  const conferences = getFilteredConferences();
  dom.conferenceResults.textContent = `${pluralize(
    conferences.length,
    "conference",
    "conferences",
  )} match your filters.`;

  if (!conferences.length) {
    dom.conferenceGrid.innerHTML = emptyState(
      "No conferences match these filters.",
      "Try widening the date range or switching the JMUN and MUN filters back to all.",
    );
    return;
  }

  dom.conferenceGrid.innerHTML = conferences.map(buildConferenceCard).join("");
}

function renderAuthShell() {
  if (!state.backendReady) {
    dom.authShell.innerHTML = emptyState(
      "Backend not connected.",
      "Start the local server first, then reload the page to use real accounts and sessions.",
    );
    return;
  }

  if (state.me) {
    dom.authShell.innerHTML = `
      <div class="auth-shell stack">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Signed in</p>
            <h2>${escapeHTML(state.me.name)}</h2>
          </div>
        </div>
        <div class="content-card">
          <div class="meta-grid">
            <div class="meta-item">
              <strong>School</strong>
              <small>${escapeHTML(state.me.school)}</small>
            </div>
            <div class="meta-item">
              <strong>Email</strong>
              <small>${escapeHTML(state.me.email)}</small>
            </div>
            <div class="meta-item">
              <strong>Experience</strong>
              <small>${escapeHTML(state.me.experienceLevel)}</small>
            </div>
            <div class="meta-item">
              <strong>Joined</strong>
              <small>${escapeHTML(formatShortDate(state.me.createdAt))}</small>
            </div>
          </div>
        </div>
        <button class="button button-secondary" id="logout-button" type="button">Log out</button>
      </div>
    `;
    return;
  }

  dom.authShell.innerHTML = `
    <div class="auth-grid">
      <form class="content-card stack" id="signup-form">
        <h3>Create account</h3>
        <label>
          Name
          <input name="name" type="text" placeholder="Ece Yilmaz" required />
        </label>
        <label>
          School
          <input name="school" type="text" placeholder="Robert College" required />
        </label>
        <label>
          Email
          <input name="email" type="email" placeholder="delegate@example.com" required />
        </label>
        <label>
          Password
          <input name="password" type="password" minlength="6" required />
        </label>
        <label>
          Experience level
          <select name="experienceLevel" required>
            ${EXPERIENCE_LEVELS.map(
              (level) => `<option value="${escapeHTML(level)}">${escapeHTML(level)}</option>`,
            ).join("")}
          </select>
        </label>
        <label>
          Bio
          <textarea name="bio" rows="3" placeholder="Chairing style, committees you like, or what kind of MUNs you usually attend."></textarea>
        </label>
        <label>
          Committees attended
          <textarea name="committeesAttended" rows="3" placeholder="UNSC, DISEC, Historical JCC"></textarea>
        </label>
        <button class="button button-primary" type="submit">Create account</button>
      </form>

      <form class="content-card stack" id="login-form">
        <h3>Log in</h3>
        <label>
          Email
          <input name="email" type="email" placeholder="delegate@example.com" required />
        </label>
        <label>
          Password
          <input name="password" type="password" required />
        </label>
        <button class="button button-secondary" type="submit">Log in</button>
        <p class="status-copy">
          One account keeps your applications, reviews, guides, awards, and conversations together.
        </p>
      </form>
    </div>
  `;
}

function renderProfileShell() {
  if (!state.backendReady) {
    dom.profileShell.innerHTML = emptyState(
      "Profile unavailable while offline.",
      "Your profile is stored in the backend, so it appears once the server is running.",
    );
    return;
  }

  if (!state.me) {
    dom.profileShell.innerHTML = emptyState(
      "Log in to manage your profile.",
      "Once you are signed in, you can update your school, experience level, bio, and committees attended here.",
    );
    return;
  }

  dom.profileShell.innerHTML = `
    <form class="profile-shell stack" id="profile-form">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Profile</p>
          <h2>Delegate profile</h2>
        </div>
      </div>
      <label>
        Name
        <input name="name" type="text" value="${escapeHTML(state.me.name)}" required />
      </label>
      <label>
        School
        <input name="school" type="text" value="${escapeHTML(state.me.school)}" required />
      </label>
      <label>
        Experience level
        <select name="experienceLevel" required>
          ${EXPERIENCE_LEVELS.map(
            (level) => `<option value="${escapeHTML(level)}" ${
              level === state.me.experienceLevel ? "selected" : ""
            }>${escapeHTML(level)}</option>`,
          ).join("")}
        </select>
      </label>
      <label>
        Bio
        <textarea name="bio" rows="4">${escapeHTML(state.me.bio || "")}</textarea>
      </label>
      <label>
        Committees attended
        <textarea name="committeesAttended" rows="4">${escapeHTML(
          (state.me.committeesAttended || []).join(", "),
        )}</textarea>
      </label>
      <button class="button button-primary" type="submit">Save profile</button>
    </form>
  `;
}

function renderApplications() {
  if (!state.backendReady) {
    dom.applicationShell.innerHTML = emptyState(
      "Application tracker unavailable while offline.",
      "Start the backend to load conferences and save application records.",
    );
    return;
  }

  if (!state.me) {
    dom.applicationShell.innerHTML = emptyState(
      "Log in to track applications.",
      "Your personal application tracker appears here once you sign in.",
    );
    return;
  }

  const selectedConferenceId =
    state.pendingConferenceId && getConferenceById(state.pendingConferenceId)
      ? state.pendingConferenceId
      : state.conferences[0]?.id || "";

  dom.applicationShell.innerHTML = `
    <div class="stack">
      <form class="workspace-card stack" id="application-form">
        <h3>Add application</h3>
        <label>
          Conference
          <select name="conferenceId" required>
            ${buildConferenceOptions(selectedConferenceId)}
          </select>
        </label>
        <label>
          Status
          <select name="status" required>
            ${APPLICATION_STATUSES.map(
              (status) => `<option value="${escapeHTML(status)}">${escapeHTML(status)}</option>`,
            ).join("")}
          </select>
        </label>
        <label>
          Notes
          <textarea name="notes" rows="3" placeholder="Committee preference, payment deadline, interview date, or any other reminders."></textarea>
        </label>
        <button class="button button-primary" type="submit">Save application</button>
      </form>

      <div class="workspace-feed">
        ${
          state.applications.length
            ? state.applications
                .map(
                  (application) => `
                    <article class="workspace-card stack">
                      <div class="feed-header">
                        <div>
                          <h3>${escapeHTML(application.conferenceShortName)}</h3>
                          <p>${escapeHTML(application.conferenceName)}</p>
                        </div>
                        <span class="status-chip">${escapeHTML(application.status)}</span>
                      </div>
                      <p>${escapeHTML(application.notes || "No notes saved yet.")}</p>
                      <p class="meta-copy">Updated ${escapeHTML(formatDateTime(application.updatedAt))}</p>
                      <div class="inline-actions">
                        <select data-application-status="${escapeHTML(String(application.id))}">
                          ${APPLICATION_STATUSES.map(
                            (status) => `<option value="${escapeHTML(status)}" ${
                              status === application.status ? "selected" : ""
                            }>${escapeHTML(status)}</option>`,
                          ).join("")}
                        </select>
                        <button class="button button-secondary" type="button" data-delete-application="${escapeHTML(
                          String(application.id),
                        )}">Delete</button>
                      </div>
                    </article>
                  `,
                )
                .join("")
            : emptyState(
                "No tracked applications yet.",
                "Use the form above or click Track application on a conference card to start your list.",
              )
        }
      </div>
    </div>
  `;
}

function renderAwards() {
  if (!state.backendReady) {
    dom.awardShell.innerHTML = emptyState(
      "Awards unavailable while offline.",
      "Award records live in the backend and appear here once the server is running.",
    );
    return;
  }

  if (!state.me) {
    dom.awardShell.innerHTML = emptyState(
      "Log in to record awards.",
      "Keep a clean record of Best Delegate, Outstanding Delegate, and other awards here.",
    );
    return;
  }

  dom.awardShell.innerHTML = `
    <div class="stack">
      <form class="workspace-card stack" id="award-form">
        <h3>Add award</h3>
        <label>
          Conference
          <select name="conferenceId" required>
            ${buildConferenceOptions()}
          </select>
        </label>
        <label>
          Award title
          <select name="title" required>
            ${AWARD_TITLES.map(
              (title) => `<option value="${escapeHTML(title)}">${escapeHTML(title)}</option>`,
            ).join("")}
          </select>
        </label>
        <label>
          Year
          <input name="year" type="number" min="2000" max="2100" value="${new Date().getFullYear()}" required />
        </label>
        <label>
          Note
          <textarea name="note" rows="3" placeholder="Committee, role, or any short detail you want to remember."></textarea>
        </label>
        <button class="button button-primary" type="submit">Save award</button>
      </form>

      <div class="workspace-feed">
        ${
          state.awards.length
            ? state.awards
                .map(
                  (award) => `
                    <article class="workspace-card stack">
                      <div class="feed-header">
                        <div>
                          <h3>${escapeHTML(award.title)}</h3>
                          <p>${escapeHTML(award.conferenceShortName)} | ${escapeHTML(String(award.year))}</p>
                        </div>
                        <button class="button button-secondary" type="button" data-delete-award="${escapeHTML(
                          String(award.id),
                        )}">Delete</button>
                      </div>
                      <p>${escapeHTML(award.note || "No extra note saved.")}</p>
                    </article>
                  `,
                )
                .join("")
            : emptyState(
                "No awards recorded yet.",
                "Add awards here to keep a cleaner delegate record than scattered screenshots or certificates.",
              )
        }
      </div>
    </div>
  `;
}

function renderAssistant() {
  if (!state.backendReady) {
    dom.assistantShell.innerHTML = emptyState(
      "Assistant unavailable while offline.",
      "Start the site normally and the assistant will be ready for speeches and resolution support.",
    );
    return;
  }

  const defaultConferenceId = state.conferences[0]?.id || "";
  dom.assistantShell.innerHTML = `
    <div class="assistant-grid">
      <form class="content-card stack" id="resolution-form">
        <h3>Resolution helper</h3>
        <label>
          Conference
          <select name="conferenceId">
            ${buildConferenceOptions(defaultConferenceId)}
          </select>
        </label>
        <label>
          Committee
          <input name="committee" type="text" placeholder="DISEC" required />
        </label>
        <label>
          Country or role
          <input name="country" type="text" placeholder="France" />
        </label>
        <label>
          Topic
          <input name="topic" type="text" placeholder="Regulating autonomous weapons" required />
        </label>
        <label>
          Goal
          <textarea name="goal" rows="4" placeholder="Build a practical draft with clear oversight, funding, and implementation language."></textarea>
        </label>
        <button class="button button-primary" type="submit">Generate resolution outline</button>
      </form>

      <article class="content-card assistant-output stack">
        <h3>Resolution output</h3>
        <pre id="resolution-output">${escapeHTML(state.assistant.resolution)}</pre>
      </article>

      <form class="content-card stack" id="speech-form">
        <h3>Speech helper</h3>
        <label>
          Conference
          <select name="conferenceId">
            ${buildConferenceOptions(defaultConferenceId)}
          </select>
        </label>
        <label>
          Committee
          <input name="committee" type="text" placeholder="UN Women" required />
        </label>
        <label>
          Country or role
          <input name="country" type="text" placeholder="Brazil" />
        </label>
        <label>
          Topic
          <input name="topic" type="text" placeholder="Combating online gender-based violence" required />
        </label>
        <label>
          Goal
          <textarea name="goal" rows="4" placeholder="Open clearly, sound cooperative, and invite co-submitters."></textarea>
        </label>
        <button class="button button-primary" type="submit">Generate speech draft</button>
      </form>

      <article class="content-card assistant-output stack">
        <h3>Speech output</h3>
        <pre id="speech-output">${escapeHTML(state.assistant.speech)}</pre>
      </article>
    </div>
  `;
}

function renderGuides() {
  if (!state.backendReady) {
    dom.guideShell.innerHTML = emptyState(
      "Guides unavailable while offline.",
      "Guide sharing and guide reading both come from the backend in this build.",
    );
    return;
  }

  dom.guideShell.innerHTML = `
    <div class="guide-layout">
      <div class="stack">
        ${
          state.me
            ? `
              <form class="content-card stack" id="guide-form">
                <h3>Share a guide</h3>
                <label>
                  Conference
                  <select name="conferenceId" required>
                    ${buildConferenceOptions()}
                  </select>
                </label>
                <label>
                  Title
                  <input name="title" type="text" placeholder="DISEC research starter pack" required />
                </label>
                <label>
                  Public link
                  <input name="link" type="url" placeholder="https://..." required />
                </label>
                <label>
                  Committee
                  <input name="committee" type="text" placeholder="DISEC" required />
                </label>
                <label>
                  Topic
                  <input name="topic" type="text" placeholder="Private military contractors" required />
                </label>
                <button class="button button-primary" type="submit">Share guide</button>
              </form>
            `
            : emptyState(
                "Log in to share guides.",
                "Guide reading is public, but posting new resources requires an account.",
              )
        }
      </div>
      <div class="card-feed">
        ${
          state.guides.length
            ? state.guides
                .map(
                  (guide) => `
                    <article class="guide-card stack">
                      <div class="feed-header">
                        <div>
                          <h3>${escapeHTML(guide.title)}</h3>
                          <p>${escapeHTML(guide.conferenceShortName)} | ${escapeHTML(guide.committee)}</p>
                        </div>
                        ${
                          state.me && guide.userId === state.me.id
                            ? `<button class="button button-secondary" type="button" data-delete-guide="${escapeHTML(
                                String(guide.id),
                              )}">Delete</button>`
                            : ""
                        }
                      </div>
                      <p>${escapeHTML(guide.topic)}</p>
                      <p class="meta-copy">Shared by ${escapeHTML(guide.userName)} | ${escapeHTML(
                        guide.userSchool,
                      )}</p>
                      <div class="button-row">
                        <a class="button button-primary" href="${escapeHTML(
                          guide.link,
                        )}" target="_blank" rel="noreferrer">Open guide</a>
                      </div>
                    </article>
                  `,
                )
                .join("")
            : emptyState(
                "No study guides yet.",
                "The first shared guides will appear here with conference, committee, and topic labels.",
              )
        }
      </div>
    </div>
  `;
}

function renderReviews() {
  if (!state.backendReady) {
    dom.reviewShell.innerHTML = emptyState(
      "Reviews unavailable while offline.",
      "Review scores and comments appear here once the site can reach the app server.",
    );
    return;
  }

  const average =
    state.reviews.length > 0
      ? (
          state.reviews.reduce((total, review) => total + review.rating, 0) /
          state.reviews.length
        ).toFixed(1)
      : "0.0";

  dom.reviewShell.innerHTML = `
    <div class="review-layout">
      <div class="stack">
        <div class="content-card stack">
          <h3>Review snapshot</h3>
          <p>${pluralize(state.reviews.length, "review", "reviews")} stored with a current average of ${average} / 5.</p>
        </div>
        ${
          state.me
            ? `
              <form class="content-card stack" id="review-form">
                <h3>Leave or update a review</h3>
                <label>
                  Conference
                  <select name="conferenceId" required>
                    ${buildConferenceOptions()}
                  </select>
                </label>
                <label>
                  Rating
                  <select name="rating" required>
                    <option value="5">5 - Excellent</option>
                    <option value="4">4 - Strong</option>
                    <option value="3">3 - Mixed</option>
                    <option value="2">2 - Weak</option>
                    <option value="1">1 - Poor</option>
                  </select>
                </label>
                <label>
                  Comment
                  <textarea name="comment" rows="5" placeholder="Academic quality, committee prep, organization, communication, scheduling, and value for money." required></textarea>
                </label>
                <button class="button button-primary" type="submit">Save review</button>
              </form>
            `
            : emptyState(
                "Log in to review conferences.",
                "Reading reviews is open, but saving a review requires a delegate account.",
              )
        }
      </div>

      <div class="card-feed">
        ${
          state.reviews.length
            ? state.reviews
                .map(
                  (review) => `
                    <article class="review-card stack">
                      <div class="feed-header">
                        <div>
                          <h3>${escapeHTML(review.conferenceShortName)}</h3>
                          <p>${escapeHTML(review.userName)} | ${escapeHTML(
                            review.userSchool,
                          )}</p>
                        </div>
                        <span class="rating-chip">${escapeHTML(buildStars(review.rating))}</span>
                      </div>
                      <p>${escapeHTML(review.comment)}</p>
                      <p class="meta-copy">Updated ${escapeHTML(formatDateTime(review.updatedAt))}</p>
                      ${
                        state.me && review.userId === state.me.id
                          ? `<button class="button button-secondary" type="button" data-delete-review="${escapeHTML(
                              String(review.id),
                            )}">Delete</button>`
                          : ""
                      }
                    </article>
                  `,
                )
                .join("")
            : emptyState(
                "No reviews yet.",
                "The review feed will fill in as delegates leave comments on conferences they attended.",
              )
        }
      </div>
    </div>
  `;
}

function renderMessages() {
  if (!state.backendReady) {
    dom.messageShell.innerHTML = emptyState(
      "Messages unavailable while offline.",
      "Direct messages only work when the local server is running and you open the site at http://localhost:3000.",
    );
    return;
  }

  if (!state.me) {
    dom.messageShell.innerHTML = emptyState(
      "Log in to use direct messages.",
      "Only registered delegates can appear in the directory and inbox.",
    );
    return;
  }

  if (!state.directory.length) {
    dom.messageShell.innerHTML = `
      <div class="split-layout">
        <div class="directory-card">
          <h3>Delegate directory</h3>
          <p class="status-copy">As soon as other users register, they will appear here and you can start a real conversation.</p>
        </div>
        ${emptyState(
          "No other users yet.",
          "Create another account in a second browser or ask another delegate to register to test live direct messages.",
        )}
      </div>
    `;
    return;
  }

  const selectedUser = getUserById(state.selectedUserId) || state.directory[0];
  if (selectedUser && selectedUser.id !== state.selectedUserId) {
    state.selectedUserId = selectedUser.id;
  }

  dom.messageShell.innerHTML = `
    <div class="split-layout">
      <div class="directory-card">
        <h3>Delegate directory</h3>
        <label>
          Search delegates
          <input id="directory-search" type="search" value="${escapeHTML(
            state.directoryQuery,
          )}" placeholder="Name, school, or experience" />
        </label>
        <div class="directory-list">
          ${state.directory
            .map(
              (user) => `
                <button
                  class="directory-button ${user.id === state.selectedUserId ? "active" : ""}"
                  type="button"
                  data-select-user="${escapeHTML(String(user.id))}"
                >
                  <strong>${escapeHTML(user.name)}</strong>
                  <span>${escapeHTML(user.school)} | ${escapeHTML(user.experienceLevel)}</span>
                  <small>${escapeHTML(user.lastMessage || user.bio || "No messages yet.")}</small>
                </button>
              `,
            )
            .join("")}
        </div>
      </div>

      <div class="message-thread-card">
        ${
          selectedUser
            ? `
              <div class="message-header">
                <div>
                  <h3>${escapeHTML(selectedUser.name)}</h3>
                  <p>${escapeHTML(selectedUser.school)} | ${escapeHTML(selectedUser.experienceLevel)}</p>
                </div>
                <span class="status-chip">Live inbox</span>
              </div>
              <p class="status-copy">${escapeHTML(
                selectedUser.bio || "No profile bio added yet.",
              )}</p>
              <div class="message-list" id="message-list">
                ${
                  state.messages.length
                    ? state.messages
                        .map(
                          (message) => `
                            <article class="message-item ${
                              message.senderId === state.me.id ? "mine" : ""
                            }">
                              <strong>${
                                message.senderId === state.me.id
                                  ? escapeHTML(state.me.name)
                                  : escapeHTML(selectedUser.name)
                              }</strong>
                              <p>${escapeHTML(message.body)}</p>
                              <small>${escapeHTML(formatDateTime(message.createdAt))}</small>
                            </article>
                          `,
                        )
                        .join("")
                    : emptyState(
                        "No messages yet.",
                        "Say hello and start the first direct conversation.",
                      )
                }
              </div>
              <form class="message-composer" id="message-form">
                <input type="hidden" name="recipientId" value="${escapeHTML(
                  String(selectedUser.id),
                )}" />
                <label>
                  Message
                  <textarea name="body" rows="4" placeholder="Hi, which committees are you applying to this season?" required></textarea>
                </label>
                <div class="message-actions">
                  <button class="button button-primary" type="submit">Send message</button>
                </div>
              </form>
            `
            : emptyState(
                "Choose a delegate to start messaging.",
                "The conversation thread will appear here once you select someone from the directory.",
              )
        }
      </div>
    </div>
  `;

  const messageList = document.getElementById("message-list");
  if (messageList) {
    messageList.scrollTop = messageList.scrollHeight;
  }
}

function renderAll() {
  renderRuntimeBanner();
  renderStats();
  renderConferences();
  renderAuthShell();
  renderProfileShell();
  renderApplications();
  renderAwards();
  renderAssistant();
  renderGuides();
  renderReviews();
  renderMessages();
}

async function loadPublicData() {
  const [conferencePayload, guidePayload, reviewPayload] = await Promise.all([
    apiRequest("/api/conferences"),
    apiRequest("/api/guides"),
    apiRequest("/api/reviews"),
  ]);

  state.conferences = conferencePayload.conferences;
  state.guides = guidePayload.guides;
  state.reviews = reviewPayload.reviews;
  hydrateFilters();
}

async function loadSessionData() {
  if (!state.me) {
    state.applications = [];
    state.awards = [];
    state.directory = [];
    state.messages = [];
    state.selectedUserId = null;
    stopMessagePolling();
    return;
  }

  const [applicationPayload, awardPayload, directoryPayload] = await Promise.all([
    apiRequest("/api/applications"),
    apiRequest("/api/awards"),
    apiRequest(`/api/directory?query=${encodeURIComponent(state.directoryQuery)}`),
  ]);

  state.applications = applicationPayload.applications;
  state.awards = awardPayload.awards;
  state.directory = directoryPayload.users;

  if (!state.directory.length) {
    state.selectedUserId = null;
    state.messages = [];
  } else {
    const stillExists = state.directory.some((user) => user.id === state.selectedUserId);
    state.selectedUserId = stillExists ? state.selectedUserId : state.directory[0].id;
    await refreshMessages(true);
  }

  startMessagePolling();
}

async function refreshSession() {
  const payload = await apiRequest("/api/me");
  state.me = payload.user;
  await loadSessionData();
}

async function refreshDirectory(silent = false) {
  if (!state.me) {
    return;
  }

  try {
    const payload = await apiRequest(
      `/api/directory?query=${encodeURIComponent(state.directoryQuery)}`,
    );
    state.directory = payload.users;
    if (!silent) {
      renderMessages();
    }
  } catch (error) {
    setStatus("message", error.message, "error");
  }
}

async function refreshMessages(silent = false) {
  if (!state.me || !state.selectedUserId) {
    state.messages = [];
    if (!silent) {
      renderMessages();
    }
    return;
  }

  try {
    const payload = await apiRequest(`/api/messages?withUserId=${state.selectedUserId}`);
    state.messages = payload.messages;
    if (!silent) {
      renderMessages();
    }
  } catch (error) {
    setStatus("message", error.message, "error");
  }
}

function startMessagePolling() {
  stopMessagePolling();
  if (!state.me) {
    return;
  }

  messagePollHandle = window.setInterval(async () => {
    await refreshDirectory(true);
    await refreshMessages(true);
    renderMessages();
  }, 8000);
}

function stopMessagePolling() {
  if (messagePollHandle) {
    window.clearInterval(messagePollHandle);
    messagePollHandle = null;
  }
}

async function handleSignupSubmit(form) {
  const formData = new FormData(form);
  const payload = await apiRequest("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({
      name: formData.get("name"),
      school: formData.get("school"),
      email: formData.get("email"),
      password: formData.get("password"),
      experienceLevel: formData.get("experienceLevel"),
      bio: formData.get("bio"),
      committeesAttended: formData.get("committeesAttended"),
    }),
  });

  state.me = payload.user;
  await loadSessionData();
  renderAll();
  setStatus("auth", payload.message, "success");
}

async function handleLoginSubmit(form) {
  const formData = new FormData(form);
  const payload = await apiRequest("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({
      email: formData.get("email"),
      password: formData.get("password"),
    }),
  });

  state.me = payload.user;
  await loadSessionData();
  renderAll();
  setStatus("auth", payload.message, "success");
}

async function handleProfileSubmit(form) {
  const formData = new FormData(form);
  const payload = await apiRequest("/api/me", {
    method: "PATCH",
    body: JSON.stringify({
      name: formData.get("name"),
      school: formData.get("school"),
      experienceLevel: formData.get("experienceLevel"),
      bio: formData.get("bio"),
      committeesAttended: formData.get("committeesAttended"),
    }),
  });

  state.me = payload.user;
  await refreshDirectory(true);
  renderAll();
  setStatus("profile", payload.message, "success");
}

async function handleApplicationSubmit(form) {
  const formData = new FormData(form);
  const payload = await apiRequest("/api/applications", {
    method: "POST",
    body: JSON.stringify({
      conferenceId: formData.get("conferenceId"),
      status: formData.get("status"),
      notes: formData.get("notes"),
    }),
  });

  state.pendingConferenceId = "";
  state.applications = payload.applications;
  renderApplications();
  setStatus("application", payload.message, "success");
}

async function handleAwardSubmit(form) {
  const formData = new FormData(form);
  const payload = await apiRequest("/api/awards", {
    method: "POST",
    body: JSON.stringify({
      conferenceId: formData.get("conferenceId"),
      title: formData.get("title"),
      year: Number(formData.get("year")),
      note: formData.get("note"),
    }),
  });

  state.awards = payload.awards;
  renderAwards();
  setStatus("award", payload.message, "success");
}

async function handleResolutionSubmit(form) {
  const formData = new FormData(form);
  const payload = await apiRequest("/api/assistant/resolution", {
    method: "POST",
    body: JSON.stringify({
      conferenceId: formData.get("conferenceId"),
      committee: formData.get("committee"),
      country: formData.get("country"),
      topic: formData.get("topic"),
      goal: formData.get("goal"),
    }),
  });

  state.assistant.resolution = payload.content;
  renderAssistant();
  setStatus("assistant", "Resolution outline generated.", "success");
}

async function handleSpeechSubmit(form) {
  const formData = new FormData(form);
  const payload = await apiRequest("/api/assistant/speech", {
    method: "POST",
    body: JSON.stringify({
      conferenceId: formData.get("conferenceId"),
      committee: formData.get("committee"),
      country: formData.get("country"),
      topic: formData.get("topic"),
      goal: formData.get("goal"),
    }),
  });

  state.assistant.speech = payload.content;
  renderAssistant();
  setStatus("assistant", "Speech draft generated.", "success");
}

async function handleGuideSubmit(form) {
  const formData = new FormData(form);
  const payload = await apiRequest("/api/guides", {
    method: "POST",
    body: JSON.stringify({
      conferenceId: formData.get("conferenceId"),
      title: formData.get("title"),
      link: formData.get("link"),
      committee: formData.get("committee"),
      topic: formData.get("topic"),
    }),
  });

  state.guides = payload.guides;
  renderGuides();
  setStatus("guide", payload.message, "success");
}

async function handleReviewSubmit(form) {
  const formData = new FormData(form);
  const payload = await apiRequest("/api/reviews", {
    method: "POST",
    body: JSON.stringify({
      conferenceId: formData.get("conferenceId"),
      rating: Number(formData.get("rating")),
      comment: formData.get("comment"),
    }),
  });

  state.reviews = payload.reviews;
  state.conferences = payload.conferences;
  hydrateFilters();
  renderStats();
  renderConferences();
  renderReviews();
  setStatus("review", payload.message, "success");
}

async function handleMessageSubmit(form) {
  const formData = new FormData(form);
  const payload = await apiRequest("/api/messages", {
    method: "POST",
    body: JSON.stringify({
      recipientId: Number(formData.get("recipientId")),
      body: formData.get("body"),
    }),
  });

  state.messages = payload.messages;
  state.directory = payload.users;
  renderMessages();
  setStatus("message", payload.message, "success");
}

async function handleSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) {
    return;
  }

  try {
    if (
      [
        "signup-form",
        "login-form",
        "profile-form",
        "application-form",
        "award-form",
        "resolution-form",
        "speech-form",
        "guide-form",
        "review-form",
        "message-form",
      ].includes(form.id)
    ) {
      event.preventDefault();
      clearStatuses();
    }

    if (form.id === "signup-form") {
      await handleSignupSubmit(form);
    }
    if (form.id === "login-form") {
      await handleLoginSubmit(form);
    }
    if (form.id === "profile-form") {
      await handleProfileSubmit(form);
    }
    if (form.id === "application-form") {
      await handleApplicationSubmit(form);
    }
    if (form.id === "award-form") {
      await handleAwardSubmit(form);
    }
    if (form.id === "resolution-form") {
      await handleResolutionSubmit(form);
    }
    if (form.id === "speech-form") {
      await handleSpeechSubmit(form);
    }
    if (form.id === "guide-form") {
      await handleGuideSubmit(form);
    }
    if (form.id === "review-form") {
      await handleReviewSubmit(form);
    }
    if (form.id === "message-form") {
      await handleMessageSubmit(form);
    }
  } catch (error) {
    const statusKey =
      form.id === "profile-form"
        ? "profile"
        : form.id === "application-form"
          ? "application"
          : form.id === "award-form"
            ? "award"
            : form.id === "resolution-form" || form.id === "speech-form"
              ? "assistant"
              : form.id === "guide-form"
                ? "guide"
                : form.id === "review-form"
                  ? "review"
                  : form.id === "message-form"
                    ? "message"
                    : "auth";
    setStatus(statusKey, error.message, "error");
  }
}

async function handleClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  try {
    if (target.id === "logout-button") {
      clearStatuses();
      const payload = await apiRequest("/api/auth/logout", { method: "POST" });
      state.me = null;
      state.applications = [];
      state.awards = [];
      state.directory = [];
      state.messages = [];
      state.selectedUserId = null;
      stopMessagePolling();
      renderAll();
      setStatus("auth", payload.message, "success");
      return;
    }

    if (target.dataset.trackConference) {
      state.pendingConferenceId = target.dataset.trackConference;
      document.getElementById("workspace").scrollIntoView({ behavior: "smooth" });
      renderApplications();
      if (!state.me) {
        document.getElementById("account").scrollIntoView({ behavior: "smooth" });
        setStatus("auth", "Log in first, then the application tracker will preselect this conference.", "error");
      } else {
        setStatus("application", "Conference preselected in the application form.", "success");
      }
      return;
    }

    if (target.dataset.deleteApplication) {
      const payload = await apiRequest(`/api/applications/${target.dataset.deleteApplication}`, {
        method: "DELETE",
      });
      state.applications = payload.applications;
      renderApplications();
      setStatus("application", payload.message, "success");
      return;
    }

    if (target.dataset.deleteAward) {
      const payload = await apiRequest(`/api/awards/${target.dataset.deleteAward}`, {
        method: "DELETE",
      });
      state.awards = payload.awards;
      renderAwards();
      setStatus("award", payload.message, "success");
      return;
    }

    if (target.dataset.deleteGuide) {
      const payload = await apiRequest(`/api/guides/${target.dataset.deleteGuide}`, {
        method: "DELETE",
      });
      state.guides = payload.guides;
      renderGuides();
      setStatus("guide", payload.message, "success");
      return;
    }

    if (target.dataset.deleteReview) {
      const payload = await apiRequest(`/api/reviews/${target.dataset.deleteReview}`, {
        method: "DELETE",
      });
      state.reviews = payload.reviews;
      state.conferences = payload.conferences;
      hydrateFilters();
      renderStats();
      renderConferences();
      renderReviews();
      setStatus("review", payload.message, "success");
      return;
    }

    if (target.dataset.selectUser) {
      state.selectedUserId = Number(target.dataset.selectUser);
      await refreshMessages(true);
      renderMessages();
    }
  } catch (error) {
    if (target.dataset.deleteApplication || target.dataset.trackConference) {
      setStatus("application", error.message, "error");
      return;
    }
    if (target.dataset.deleteAward) {
      setStatus("award", error.message, "error");
      return;
    }
    if (target.dataset.deleteGuide) {
      setStatus("guide", error.message, "error");
      return;
    }
    if (target.dataset.deleteReview) {
      setStatus("review", error.message, "error");
      return;
    }
    setStatus("message", error.message, "error");
  }
}

async function handleChange(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  if (target === dom.cityFilter) {
    state.filters.city = dom.cityFilter.value;
    renderConferences();
  }
  if (target === dom.formatFilter) {
    state.filters.format = dom.formatFilter.value;
    renderConferences();
  }
  if (target === dom.levelFilter) {
    state.filters.level = dom.levelFilter.value;
    renderConferences();
  }
  if (target === dom.languageFilter) {
    state.filters.language = dom.languageFilter.value;
    renderConferences();
  }
  if (target === dom.fromDateFilter) {
    state.filters.fromDate = dom.fromDateFilter.value;
    renderConferences();
  }
  if (target === dom.toDateFilter) {
    state.filters.toDate = dom.toDateFilter.value;
    renderConferences();
  }

  if (target instanceof HTMLSelectElement && target.dataset.applicationStatus) {
    try {
      clearStatuses();
      const applicationId = Number(target.dataset.applicationStatus);
      const application = state.applications.find((item) => item.id === applicationId);
      const payload = await apiRequest(`/api/applications/${applicationId}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: target.value,
          notes: application ? application.notes : "",
        }),
      });
      state.applications = payload.applications;
      renderApplications();
      setStatus("application", payload.message, "success");
    } catch (error) {
      setStatus("application", error.message, "error");
    }
  }
}

async function handleInput(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  if (target === dom.searchFilter) {
    state.filters.search = dom.searchFilter.value;
    renderConferences();
  }

  if (target.id === "directory-search" && target instanceof HTMLInputElement) {
    state.directoryQuery = target.value;
    await refreshDirectory();
    if (
      state.selectedUserId &&
      !state.directory.some((user) => user.id === state.selectedUserId)
    ) {
      state.selectedUserId = state.directory[0]?.id || null;
      await refreshMessages(true);
    }
    renderMessages();
  }
}

function bindEvents() {
  document.addEventListener("submit", (event) => {
    handleSubmit(event);
  });
  document.addEventListener("click", (event) => {
    handleClick(event);
  });
  document.addEventListener("change", (event) => {
    handleChange(event);
  });
  document.addEventListener("input", (event) => {
    handleInput(event);
  });

  dom.resetFilters.addEventListener("click", () => {
    state.filters = {
      search: "",
      city: "all",
      format: "all",
      level: "all",
      language: "all",
      fromDate: "",
      toDate: "",
    };

    dom.searchFilter.value = "";
    dom.cityFilter.value = "all";
    dom.formatFilter.value = "all";
    dom.levelFilter.value = "all";
    dom.languageFilter.value = "all";
    dom.fromDateFilter.value = "";
    dom.toDateFilter.value = "";
    renderConferences();
  });
}

async function boot() {
  bindEvents();

  try {
    await loadPublicData();
    state.backendReady = true;
    state.backendMessage = "";
    await refreshSession();
    renderAll();
  } catch (error) {
    state.backendReady = false;
    state.backendMessage = getBackendHelpMessage();
    renderAll();
  }
}

window.addEventListener("beforeunload", () => {
  stopMessagePolling();
});

boot();
