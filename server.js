const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const ROOT_DIR = __dirname;
const DATA_DIR = path.resolve(String(process.env.DATA_DIR || path.join(ROOT_DIR, "data")));
const DB_PATH = path.resolve(String(process.env.DB_PATH || path.join(DATA_DIR, "mun-turkey.sqlite")));
const SESSION_COOKIE = "mun_turkey_session";
const SESSION_MAX_AGE = Number(process.env.SESSION_MAX_AGE || 60 * 60 * 24 * 14);
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || "").trim();
const DEFAULT_PORT = Number(process.env.PORT || 3000);
const STATIC_FILES = {
  "/": "index.html",
  "/index.html": "index.html",
  "/styles.css": "styles.css",
  "/app.js": "app.js",
};
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
};
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
const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const rateLimitStore = new Map();

function nowISO() {
  return new Date().toISOString();
}

function readConferenceSeed(seedPath) {
  const source = fs.readFileSync(seedPath, "utf8");
  const sandbox = { window: {} };
  vm.runInNewContext(source, sandbox, { filename: seedPath });
  return Array.isArray(sandbox.window.CONFERENCE_DB) ? sandbox.window.CONFERENCE_DB : [];
}

function jsonText(value, fallback) {
  try {
    return JSON.stringify(Array.isArray(value) ? value : fallback);
  } catch (error) {
    return JSON.stringify(fallback);
  }
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function cleanText(value, maxLength = 1000) {
  return String(value || "").trim().slice(0, maxLength);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedValue) {
  const [salt, storedHash] = String(storedValue || "").split(":");
  if (!salt || !storedHash) {
    return false;
  }

  const candidate = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(storedHash, "hex"));
}

function parseCookies(cookieHeader) {
  return String(cookieHeader || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((accumulator, entry) => {
      const separatorIndex = entry.indexOf("=");
      if (separatorIndex < 0) {
        return accumulator;
      }

      const key = entry.slice(0, separatorIndex).trim();
      const value = entry.slice(separatorIndex + 1).trim();
      accumulator[key] = decodeURIComponent(value);
      return accumulator;
    }, {});
}

function getBaseOriginHost() {
  if (!PUBLIC_BASE_URL) {
    return "";
  }

  try {
    return new URL(PUBLIC_BASE_URL).host;
  } catch (error) {
    return "";
  }
}

function getRequestHost(request) {
  return String(request.headers.host || "").trim().toLowerCase();
}

function getClientIp(request) {
  const forwarded = String(request.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  return forwarded || request.socket.remoteAddress || "unknown";
}

function isSecureRequest(request) {
  if (String(process.env.COOKIE_SECURE || "").toLowerCase() === "true") {
    return true;
  }

  const forwardedProto = String(request.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  return forwardedProto === "https";
}

function isAllowedOrigin(request) {
  const origin = String(request.headers.origin || "").trim();
  if (!origin) {
    return true;
  }

  try {
    const originHost = new URL(origin).host.toLowerCase();
    const requestHost = getRequestHost(request);
    const baseOriginHost = getBaseOriginHost();
    return originHost === requestHost || (baseOriginHost && originHost === baseOriginHost);
  } catch (error) {
    return false;
  }
}

function applySecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  );
}

function hitRateLimit(request, bucket, limit, windowMs) {
  const now = Date.now();
  const key = `${bucket}:${getClientIp(request)}`;
  const current = rateLimitStore.get(key);

  if (!current || current.expiresAt <= now) {
    rateLimitStore.set(key, {
      count: 1,
      expiresAt: now + windowMs,
    });
    return false;
  }

  current.count += 1;
  if (current.count > limit) {
    return true;
  }

  return false;
}

function setCookie(request, response, name, value, maxAgeSeconds) {
  const secure = isSecureRequest(request) ? "; Secure" : "";
  response.setHeader("Set-Cookie", [
    `${name}=${encodeURIComponent(value)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}; Priority=High${secure}`,
  ]);
}

function clearCookie(request, response, name) {
  const secure = isSecureRequest(request) ? "; Secure" : "";
  response.setHeader("Set-Cookie", [`${name}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure}`]);
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  applySecurityHeaders(response);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function sendError(response, statusCode, message) {
  sendJson(response, statusCode, { error: message });
}

function notFound(response) {
  sendError(response, 404, "Not found.");
}

function methodNotAllowed(response) {
  sendError(response, 405, "Method not allowed.");
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";

    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });

    request.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("Invalid JSON payload."));
      }
    });

    request.on("error", reject);
  });
}

function initializeDatabase(rootDir) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      school TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      experience_level TEXT NOT NULL,
      bio TEXT NOT NULL DEFAULT '',
      committees_attended_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conferences (
      id TEXT PRIMARY KEY,
      short_name TEXT NOT NULL,
      name TEXT NOT NULL,
      city TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      apply_start TEXT NOT NULL,
      apply_end TEXT NOT NULL,
      delegates INTEGER NOT NULL DEFAULT 0,
      language TEXT NOT NULL,
      education_levels_json TEXT NOT NULL,
      formats_json TEXT NOT NULL,
      fees TEXT NOT NULL,
      description TEXT NOT NULL,
      application_link TEXT NOT NULL,
      source_label TEXT NOT NULL,
      source_url TEXT NOT NULL,
      official_url TEXT NOT NULL DEFAULT '',
      last_verified TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conference_committees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conference_id TEXT NOT NULL REFERENCES conferences(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      topic TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conference_id TEXT NOT NULL REFERENCES conferences(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS awards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conference_id TEXT NOT NULL REFERENCES conferences(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      year INTEGER NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS guides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conference_id TEXT NOT NULL REFERENCES conferences(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      link TEXT NOT NULL,
      committee TEXT NOT NULL,
      topic TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conference_id TEXT NOT NULL REFERENCES conferences(id) ON DELETE CASCADE,
      rating INTEGER NOT NULL,
      comment TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, conference_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  syncConferenceSeed(db, path.join(rootDir, "conference-db.js"));
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(nowISO());
  return db;
}

function syncConferenceSeed(db, seedPath) {
  const conferences = readConferenceSeed(seedPath);
  const upsertConference = db.prepare(`
    INSERT INTO conferences (
      id,
      short_name,
      name,
      city,
      start_date,
      end_date,
      apply_start,
      apply_end,
      delegates,
      language,
      education_levels_json,
      formats_json,
      fees,
      description,
      application_link,
      source_label,
      source_url,
      official_url,
      last_verified
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      short_name = excluded.short_name,
      name = excluded.name,
      city = excluded.city,
      start_date = excluded.start_date,
      end_date = excluded.end_date,
      apply_start = excluded.apply_start,
      apply_end = excluded.apply_end,
      delegates = excluded.delegates,
      language = excluded.language,
      education_levels_json = excluded.education_levels_json,
      formats_json = excluded.formats_json,
      fees = excluded.fees,
      description = excluded.description,
      application_link = excluded.application_link,
      source_label = excluded.source_label,
      source_url = excluded.source_url,
      official_url = excluded.official_url,
      last_verified = excluded.last_verified
  `);
  const deleteCommittees = db.prepare("DELETE FROM conference_committees WHERE conference_id = ?");
  const insertCommittee = db.prepare(`
    INSERT INTO conference_committees (conference_id, name, topic)
    VALUES (?, ?, ?)
  `);

  db.exec("BEGIN");
  try {
    for (const conference of conferences) {
      upsertConference.run(
        cleanText(conference.id, 120),
        cleanText(conference.shortName, 120),
        cleanText(conference.name, 240),
        cleanText(conference.city, 120),
        cleanText(conference.startDate, 20),
        cleanText(conference.endDate, 20),
        cleanText(conference.applyStart, 20),
        cleanText(conference.applyEnd, 20),
        Number(conference.delegates || 0),
        cleanText(conference.language, 120),
        jsonText(conference.educationLevels, []),
        jsonText(conference.formats, []),
        cleanText(conference.fees, 240),
        cleanText(conference.description, 1200),
        cleanText(conference.applicationLink, 400),
        cleanText(conference.sourceLabel, 120),
        cleanText(conference.sourceUrl, 400),
        cleanText(conference.officialUrl, 400),
        cleanText(conference.lastVerified, 20),
      );

      deleteCommittees.run(conference.id);
      for (const committee of conference.committees || []) {
        insertCommittee.run(
          cleanText(conference.id, 120),
          cleanText(committee.name, 240),
          cleanText(committee.topic, 600),
        );
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function serializeUser(row, options = {}) {
  if (!row) {
    return null;
  }

  const base = {
    id: row.id,
    name: row.name,
    school: row.school,
    experienceLevel: row.experience_level,
    bio: row.bio,
    committeesAttended: parseJsonArray(row.committees_attended_json),
    createdAt: row.created_at,
  };

  if (!options.publicProfile) {
    base.email = row.email;
    base.updatedAt = row.updated_at;
  }

  if (Object.prototype.hasOwnProperty.call(row, "last_message")) {
    base.lastMessage = row.last_message || "";
    base.lastMessageAt = row.last_message_at || "";
  }

  return base;
}

function getSessionUser(db, request) {
  const cookies = parseCookies(request.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  if (!token) {
    return null;
  }

  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(nowISO());

  const row = db
    .prepare(`
      SELECT users.*
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.id = ? AND sessions.expires_at > ?
    `)
    .get(token, nowISO());

  return row || null;
}

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const createdAt = nowISO();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE * 1000).toISOString();

  db.prepare(`
    INSERT INTO sessions (id, user_id, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(token, userId, createdAt, expiresAt);

  return token;
}

function getConferenceRows(db) {
  const rows = db
    .prepare(`
      SELECT
        conferences.*,
        COUNT(DISTINCT conference_committees.id) AS committee_count,
        COUNT(DISTINCT reviews.id) AS review_count,
        ROUND(AVG(reviews.rating), 1) AS review_average
      FROM conferences
      LEFT JOIN conference_committees
        ON conference_committees.conference_id = conferences.id
      LEFT JOIN reviews
        ON reviews.conference_id = conferences.id
      GROUP BY conferences.id
      ORDER BY conferences.start_date ASC, conferences.name ASC
    `)
    .all();

  const committees = db
    .prepare(`
      SELECT conference_id, name, topic
      FROM conference_committees
      ORDER BY conference_id ASC, id ASC
    `)
    .all();

  const committeeMap = new Map();
  for (const committee of committees) {
    const bucket = committeeMap.get(committee.conference_id) || [];
    bucket.push({
      name: committee.name,
      topic: committee.topic,
    });
    committeeMap.set(committee.conference_id, bucket);
  }

  return rows.map((row) => ({
    id: row.id,
    shortName: row.short_name,
    name: row.name,
    city: row.city,
    startDate: row.start_date,
    endDate: row.end_date,
    applyStart: row.apply_start,
    applyEnd: row.apply_end,
    delegates: row.delegates,
    language: row.language,
    educationLevels: parseJsonArray(row.education_levels_json),
    formats: parseJsonArray(row.formats_json),
    fees: row.fees,
    description: row.description,
    applicationLink: row.application_link,
    sourceLabel: row.source_label,
    sourceUrl: row.source_url,
    officialUrl: row.official_url,
    lastVerified: row.last_verified,
    committeeCount: row.committee_count || 0,
    reviewCount: row.review_count || 0,
    reviewAverage: row.review_average || 0,
    committees: committeeMap.get(row.id) || [],
  }));
}

function ensureConferenceExists(db, conferenceId) {
  const row = db.prepare("SELECT id FROM conferences WHERE id = ?").get(conferenceId);
  return Boolean(row);
}

function ensureUserExists(db, userId) {
  const row = db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
  return Boolean(row);
}

function getApplicationsForUser(db, userId) {
  return db
    .prepare(`
      SELECT
        applications.id,
        applications.conference_id,
        applications.status,
        applications.notes,
        applications.created_at,
        applications.updated_at,
        conferences.name AS conference_name,
        conferences.short_name AS conference_short_name
      FROM applications
      JOIN conferences ON conferences.id = applications.conference_id
      WHERE applications.user_id = ?
      ORDER BY applications.updated_at DESC, applications.id DESC
    `)
    .all(userId)
    .map((row) => ({
      id: row.id,
      conferenceId: row.conference_id,
      conferenceName: row.conference_name,
      conferenceShortName: row.conference_short_name,
      status: row.status,
      notes: row.notes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
}

function getAwardsForUser(db, userId) {
  return db
    .prepare(`
      SELECT
        awards.id,
        awards.title,
        awards.year,
        awards.note,
        awards.created_at,
        conferences.id AS conference_id,
        conferences.name AS conference_name,
        conferences.short_name AS conference_short_name
      FROM awards
      JOIN conferences ON conferences.id = awards.conference_id
      WHERE awards.user_id = ?
      ORDER BY awards.year DESC, awards.created_at DESC, awards.id DESC
    `)
    .all(userId)
    .map((row) => ({
      id: row.id,
      title: row.title,
      year: row.year,
      note: row.note,
      conferenceId: row.conference_id,
      conferenceName: row.conference_name,
      conferenceShortName: row.conference_short_name,
      createdAt: row.created_at,
    }));
}

function getGuideRows(db) {
  return db
    .prepare(`
      SELECT
        guides.id,
        guides.user_id,
        guides.conference_id,
        guides.title,
        guides.link,
        guides.committee,
        guides.topic,
        guides.created_at,
        users.name AS user_name,
        users.school AS user_school,
        conferences.short_name AS conference_short_name,
        conferences.name AS conference_name
      FROM guides
      JOIN users ON users.id = guides.user_id
      JOIN conferences ON conferences.id = guides.conference_id
      ORDER BY guides.created_at DESC, guides.id DESC
    `)
    .all()
    .map((row) => ({
      id: row.id,
      userId: row.user_id,
      conferenceId: row.conference_id,
      conferenceShortName: row.conference_short_name,
      conferenceName: row.conference_name,
      title: row.title,
      link: row.link,
      committee: row.committee,
      topic: row.topic,
      userName: row.user_name,
      userSchool: row.user_school,
      createdAt: row.created_at,
    }));
}

function getReviewRows(db) {
  return db
    .prepare(`
      SELECT
        reviews.id,
        reviews.user_id,
        reviews.conference_id,
        reviews.rating,
        reviews.comment,
        reviews.created_at,
        reviews.updated_at,
        users.name AS user_name,
        users.school AS user_school,
        conferences.short_name AS conference_short_name,
        conferences.name AS conference_name
      FROM reviews
      JOIN users ON users.id = reviews.user_id
      JOIN conferences ON conferences.id = reviews.conference_id
      ORDER BY reviews.updated_at DESC, reviews.id DESC
    `)
    .all()
    .map((row) => ({
      id: row.id,
      userId: row.user_id,
      conferenceId: row.conference_id,
      conferenceShortName: row.conference_short_name,
      conferenceName: row.conference_name,
      rating: row.rating,
      comment: row.comment,
      userName: row.user_name,
      userSchool: row.user_school,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
}

function getDirectoryRows(db, currentUserId, query) {
  const search = `%${cleanText(query, 120).toLowerCase()}%`;
  return db
    .prepare(`
      SELECT
        users.*,
        (
          SELECT messages.body
          FROM messages
          WHERE (
            (messages.sender_id = users.id AND messages.recipient_id = ?)
            OR
            (messages.sender_id = ? AND messages.recipient_id = users.id)
          )
          ORDER BY messages.created_at DESC, messages.id DESC
          LIMIT 1
        ) AS last_message,
        (
          SELECT messages.created_at
          FROM messages
          WHERE (
            (messages.sender_id = users.id AND messages.recipient_id = ?)
            OR
            (messages.sender_id = ? AND messages.recipient_id = users.id)
          )
          ORDER BY messages.created_at DESC, messages.id DESC
          LIMIT 1
        ) AS last_message_at
      FROM users
      WHERE users.id != ?
        AND (
          lower(users.name) LIKE ?
          OR lower(users.school) LIKE ?
          OR lower(users.experience_level) LIKE ?
        )
      ORDER BY
        CASE WHEN last_message_at IS NULL THEN 1 ELSE 0 END,
        last_message_at DESC,
        users.name ASC
    `)
    .all(currentUserId, currentUserId, currentUserId, currentUserId, currentUserId, search, search, search)
    .map((row) => serializeUser(row, { publicProfile: true }));
}

function getMessagesBetweenUsers(db, firstUserId, secondUserId) {
  return db
    .prepare(`
      SELECT id, sender_id, recipient_id, body, created_at
      FROM messages
      WHERE
        (sender_id = ? AND recipient_id = ?)
        OR
        (sender_id = ? AND recipient_id = ?)
      ORDER BY created_at ASC, id ASC
    `)
    .all(firstUserId, secondUserId, secondUserId, firstUserId)
    .map((row) => ({
      id: row.id,
      senderId: row.sender_id,
      recipientId: row.recipient_id,
      body: row.body,
      createdAt: row.created_at,
    }));
}

function getConferenceContext(db, conferenceId) {
  if (!conferenceId) {
    return null;
  }

  return getConferenceRows(db).find((conference) => conference.id === conferenceId) || null;
}

function sentenceCase(value) {
  const text = cleanText(value, 240);
  if (!text) {
    return "";
  }

  return text.charAt(0).toUpperCase() + text.slice(1);
}

function buildResolutionDraft({ conference, committee, country, topic, goal, user }) {
  const conferenceLabel = conference
    ? `${conference.shortName} (${conference.city}, ${formatConferenceDates(conference)})`
    : "your selected conference";
  const roleLabel = country || user?.name || "your delegation";
  const committeeLabel = committee || inferCommittee(conference) || "the committee";
  const priority = goal || `build a practical resolution on ${topic}`;
  const committeeReferences = (conference?.committees || [])
    .slice(0, 3)
    .map((item) => `${item.name}: ${item.topic}`)
    .join(" | ");

  return [
    `${roleLabel} | ${committeeLabel} | ${conferenceLabel}`,
    "",
    `Focus`,
    `${roleLabel} should frame ${topic} as an issue that requires practical, fundable, and monitorable action. The main goal in this draft is to ${priority}.`,
    "",
    `Suggested structure`,
    `1. Open with a short problem statement that defines the current risk around ${topic}.`,
    `2. Add one clause on coordination between member states, UN bodies, and conference-relevant stakeholders.`,
    `3. Add one clause on funding or implementation support so the draft is not only declarative.`,
    `4. Add one clause on reporting, oversight, or timeline review so delegates can measure progress.`,
    `5. End with a realistic follow-up mechanism rather than an overly broad final promise.`,
    "",
    `Bloc strategy`,
    `Keep the tone balanced, cooperative, and specific. Avoid promising universal compliance immediately. Instead, push for phased implementation, reporting cycles, and partnerships that other delegates can comfortably co-submit.`,
    "",
    `Research checklist`,
    `- Two current facts or statistics you can cite on ${topic}`,
    `- The legal or policy framework most relevant to ${committeeLabel}`,
    `- One funding mechanism or implementation partner`,
    `- One likely objection from opposing blocs and your answer to it`,
    "",
    `Conference context`,
    conference
      ? `This conference listing currently shows these committee references: ${committeeReferences || "Topic details are limited on the public source."}`
      : `No conference-specific context was provided, so keep the draft broad and adaptable.`,
  ].join("\n");
}

function buildSpeechDraft({ conference, committee, country, topic, goal, user }) {
  const conferenceLabel = conference ? conference.shortName : "this conference";
  const roleLabel = country || user?.name || "the delegation";
  const committeeLabel = committee || inferCommittee(conference) || "the committee";
  const goalLine = goal
    ? `The speech should aim to ${goal}.`
    : `The speech should establish a clear, cooperative opening position.`;

  return [
    `Opening speech draft`,
    "",
    `Honourable chairs, distinguished delegates,`,
    `${roleLabel} believes that ${topic} demands calm, practical, and coordinated action in ${committeeLabel}.`,
    `Too often, this issue is discussed in abstract terms; however, delegates in ${conferenceLabel} should focus on what can actually be implemented and monitored.`,
    `${goalLine}`,
    `${roleLabel} therefore encourages this committee to prioritize realistic cooperation, strong reporting measures, and policies that can win broad support across blocs.`,
    `We invite fellow delegates to move beyond symbolic language and work toward solutions that are specific, credible, and achievable.`,
    `Thank you.`,
    "",
    `Delivery notes`,
    `- Open steadily and keep the first sentence deliberate.`,
    `- Stress one or two concrete priorities instead of listing too many ideas.`,
    `- Pause before the final invitation line so it feels like a coalition-building moment.`,
  ].join("\n");
}

function inferCommittee(conference) {
  return conference?.committees?.[0]?.name || "";
}

function formatConferenceDates(conference) {
  return `${conference.startDate} to ${conference.endDate}`;
}

async function handleApiRequest(request, response, db, pathname, url) {
  const currentUser = getSessionUser(db, request);

  if (request.method === "GET" && pathname === "/api/health") {
    sendJson(response, 200, { ok: true, time: nowISO() });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/me") {
    sendJson(response, 200, { user: serializeUser(currentUser) });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/conferences") {
    sendJson(response, 200, { conferences: getConferenceRows(db) });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/reviews") {
    sendJson(response, 200, { reviews: getReviewRows(db) });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/guides") {
    sendJson(response, 200, { guides: getGuideRows(db) });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/assistant/resolution") {
    if (hitRateLimit(request, "assistant", 30, 60 * 1000)) {
      sendError(response, 429, "Too many assistant requests. Please wait a moment and try again.");
      return true;
    }

    const body = await readJsonBody(request);
    const conference = getConferenceContext(db, cleanText(body.conferenceId, 120));
    const topic = sentenceCase(body.topic);
    if (!topic) {
      sendError(response, 400, "Please add a topic before asking for a resolution outline.");
      return true;
    }

    sendJson(response, 200, {
      title: "Resolution helper",
      content: buildResolutionDraft({
        conference,
        committee: sentenceCase(body.committee),
        country: sentenceCase(body.country),
        topic,
        goal: cleanText(body.goal, 320),
        user: currentUser ? serializeUser(currentUser) : null,
      }),
    });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/assistant/speech") {
    if (hitRateLimit(request, "assistant", 30, 60 * 1000)) {
      sendError(response, 429, "Too many assistant requests. Please wait a moment and try again.");
      return true;
    }

    const body = await readJsonBody(request);
    const conference = getConferenceContext(db, cleanText(body.conferenceId, 120));
    const topic = sentenceCase(body.topic);
    if (!topic) {
      sendError(response, 400, "Please add a topic before asking for a speech draft.");
      return true;
    }

    sendJson(response, 200, {
      title: "Speech helper",
      content: buildSpeechDraft({
        conference,
        committee: sentenceCase(body.committee),
        country: sentenceCase(body.country),
        topic,
        goal: cleanText(body.goal, 320),
        user: currentUser ? serializeUser(currentUser) : null,
      }),
    });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/auth/signup") {
    if (hitRateLimit(request, "auth", 10, 10 * 60 * 1000)) {
      sendError(response, 429, "Too many sign-up attempts. Please wait a few minutes and try again.");
      return true;
    }

    const body = await readJsonBody(request);
    const name = cleanText(body.name, 120);
    const school = cleanText(body.school, 160);
    const email = cleanText(body.email, 160).toLowerCase();
    const password = String(body.password || "");
    const experienceLevel = cleanText(body.experienceLevel, 80);
    const bio = cleanText(body.bio, 400);
    const committeesAttended = Array.isArray(body.committeesAttended)
      ? body.committeesAttended.map((item) => cleanText(item, 120)).filter(Boolean)
      : cleanText(body.committeesAttended, 400)
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
          .slice(0, 20);

    if (!name || !school || !email || !experienceLevel || password.length < 6) {
      sendError(response, 400, "Please provide name, school, email, experience level, and a password with at least 6 characters.");
      return true;
    }

    const existingUser = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
    if (existingUser) {
      sendError(response, 409, "An account with this email already exists.");
      return true;
    }

    const createdAt = nowISO();
    const result = db
      .prepare(`
        INSERT INTO users (
          name,
          school,
          email,
          password_hash,
          experience_level,
          bio,
          committees_attended_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        name,
        school,
        email,
        hashPassword(password),
        experienceLevel,
        bio,
        JSON.stringify(committeesAttended),
        createdAt,
        createdAt,
      );

    const token = createSession(db, result.lastInsertRowid);
    setCookie(request, response, SESSION_COOKIE, token, SESSION_MAX_AGE);
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(result.lastInsertRowid);
    sendJson(response, 201, {
      message: "Account created.",
      user: serializeUser(user),
    });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/auth/login") {
    if (hitRateLimit(request, "auth", 20, 10 * 60 * 1000)) {
      sendError(response, 429, "Too many login attempts. Please wait a few minutes and try again.");
      return true;
    }

    const body = await readJsonBody(request);
    const email = cleanText(body.email, 160).toLowerCase();
    const password = String(body.password || "");
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);

    if (!user || !verifyPassword(password, user.password_hash)) {
      sendError(response, 401, "Incorrect email or password.");
      return true;
    }

    const token = createSession(db, user.id);
    setCookie(request, response, SESSION_COOKIE, token, SESSION_MAX_AGE);
    sendJson(response, 200, {
      message: "Logged in.",
      user: serializeUser(user),
    });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/auth/logout") {
    const cookies = parseCookies(request.headers.cookie);
    const token = cookies[SESSION_COOKIE];
    if (token) {
      db.prepare("DELETE FROM sessions WHERE id = ?").run(token);
    }
    clearCookie(request, response, SESSION_COOKIE);
    sendJson(response, 200, { message: "Logged out." });
    return true;
  }

  if (!currentUser) {
    if (pathname.startsWith("/api/")) {
      sendError(response, 401, "Please log in first.");
      return true;
    }
    return false;
  }

  if (request.method === "PATCH" && pathname === "/api/me") {
    const body = await readJsonBody(request);
    const name = cleanText(body.name, 120);
    const school = cleanText(body.school, 160);
    const experienceLevel = cleanText(body.experienceLevel, 80);
    const bio = cleanText(body.bio, 400);
    const committeesAttended = Array.isArray(body.committeesAttended)
      ? body.committeesAttended.map((item) => cleanText(item, 120)).filter(Boolean)
      : cleanText(body.committeesAttended, 400)
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
          .slice(0, 20);

    if (!name || !school || !experienceLevel) {
      sendError(response, 400, "Profile updates need name, school, and experience level.");
      return true;
    }

    db.prepare(`
      UPDATE users
      SET
        name = ?,
        school = ?,
        experience_level = ?,
        bio = ?,
        committees_attended_json = ?,
        updated_at = ?
      WHERE id = ?
    `).run(name, school, experienceLevel, bio, JSON.stringify(committeesAttended), nowISO(), currentUser.id);

    const updatedUser = db.prepare("SELECT * FROM users WHERE id = ?").get(currentUser.id);
    sendJson(response, 200, {
      message: "Profile updated.",
      user: serializeUser(updatedUser),
    });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/applications") {
    sendJson(response, 200, { applications: getApplicationsForUser(db, currentUser.id) });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/applications") {
    const body = await readJsonBody(request);
    const conferenceId = cleanText(body.conferenceId, 120);
    const status = cleanText(body.status, 40);
    const notes = cleanText(body.notes, 600);

    if (!ensureConferenceExists(db, conferenceId) || !APPLICATION_STATUSES.includes(status)) {
      sendError(response, 400, "Please choose a valid conference and application status.");
      return true;
    }

    const createdAt = nowISO();
    db.prepare(`
      INSERT INTO applications (user_id, conference_id, status, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(currentUser.id, conferenceId, status, notes, createdAt, createdAt);

    sendJson(response, 201, {
      message: "Application saved.",
      applications: getApplicationsForUser(db, currentUser.id),
    });
    return true;
  }

  const applicationMatch = pathname.match(/^\/api\/applications\/(\d+)$/);
  if (applicationMatch) {
    const applicationId = Number(applicationMatch[1]);
    if (request.method === "PATCH") {
      const body = await readJsonBody(request);
      const status = cleanText(body.status, 40);
      const notes = cleanText(body.notes, 600);

      if (!APPLICATION_STATUSES.includes(status)) {
        sendError(response, 400, "Please choose a valid application status.");
        return true;
      }

      const result = db.prepare(`
        UPDATE applications
        SET status = ?, notes = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
      `).run(status, notes, nowISO(), applicationId, currentUser.id);

      if (!result.changes) {
        sendError(response, 404, "Application not found.");
        return true;
      }

      sendJson(response, 200, {
        message: "Application updated.",
        applications: getApplicationsForUser(db, currentUser.id),
      });
      return true;
    }

    if (request.method === "DELETE") {
      const result = db
        .prepare("DELETE FROM applications WHERE id = ? AND user_id = ?")
        .run(applicationId, currentUser.id);
      if (!result.changes) {
        sendError(response, 404, "Application not found.");
        return true;
      }

      sendJson(response, 200, {
        message: "Application deleted.",
        applications: getApplicationsForUser(db, currentUser.id),
      });
      return true;
    }
  }

  if (request.method === "GET" && pathname === "/api/awards") {
    sendJson(response, 200, { awards: getAwardsForUser(db, currentUser.id) });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/awards") {
    const body = await readJsonBody(request);
    const conferenceId = cleanText(body.conferenceId, 120);
    const title = cleanText(body.title, 80);
    const note = cleanText(body.note, 300);
    const year = Number(body.year);

    if (!ensureConferenceExists(db, conferenceId) || !AWARD_TITLES.includes(title) || !Number.isInteger(year)) {
      sendError(response, 400, "Please provide a valid conference, award title, and year.");
      return true;
    }

    db.prepare(`
      INSERT INTO awards (user_id, conference_id, title, year, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(currentUser.id, conferenceId, title, year, note, nowISO());

    sendJson(response, 201, {
      message: "Award added.",
      awards: getAwardsForUser(db, currentUser.id),
    });
    return true;
  }

  const awardMatch = pathname.match(/^\/api\/awards\/(\d+)$/);
  if (awardMatch && request.method === "DELETE") {
    const result = db.prepare("DELETE FROM awards WHERE id = ? AND user_id = ?").run(Number(awardMatch[1]), currentUser.id);
    if (!result.changes) {
      sendError(response, 404, "Award not found.");
      return true;
    }

    sendJson(response, 200, {
      message: "Award deleted.",
      awards: getAwardsForUser(db, currentUser.id),
    });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/guides") {
    const body = await readJsonBody(request);
    const conferenceId = cleanText(body.conferenceId, 120);
    const title = cleanText(body.title, 160);
    const link = cleanText(body.link, 400);
    const committee = cleanText(body.committee, 160);
    const topic = cleanText(body.topic, 240);

    if (!ensureConferenceExists(db, conferenceId) || !title || !link || !committee || !topic) {
      sendError(response, 400, "Please provide a valid conference, title, link, committee, and topic.");
      return true;
    }

    db.prepare(`
      INSERT INTO guides (user_id, conference_id, title, link, committee, topic, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(currentUser.id, conferenceId, title, link, committee, topic, nowISO());

    sendJson(response, 201, {
      message: "Guide shared.",
      guides: getGuideRows(db),
    });
    return true;
  }

  const guideMatch = pathname.match(/^\/api\/guides\/(\d+)$/);
  if (guideMatch && request.method === "DELETE") {
    const result = db.prepare("DELETE FROM guides WHERE id = ? AND user_id = ?").run(Number(guideMatch[1]), currentUser.id);
    if (!result.changes) {
      sendError(response, 404, "Guide not found.");
      return true;
    }

    sendJson(response, 200, {
      message: "Guide deleted.",
      guides: getGuideRows(db),
    });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/reviews") {
    const body = await readJsonBody(request);
    const conferenceId = cleanText(body.conferenceId, 120);
    const rating = Number(body.rating);
    const comment = cleanText(body.comment, 1200);

    if (!ensureConferenceExists(db, conferenceId) || !Number.isInteger(rating) || rating < 1 || rating > 5 || !comment) {
      sendError(response, 400, "Please provide a valid conference, rating, and review comment.");
      return true;
    }

    const createdAt = nowISO();
    db.prepare(`
      INSERT INTO reviews (user_id, conference_id, rating, comment, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, conference_id) DO UPDATE SET
        rating = excluded.rating,
        comment = excluded.comment,
        updated_at = excluded.updated_at
    `).run(currentUser.id, conferenceId, rating, comment, createdAt, createdAt);

    sendJson(response, 201, {
      message: "Review saved.",
      reviews: getReviewRows(db),
      conferences: getConferenceRows(db),
    });
    return true;
  }

  const reviewMatch = pathname.match(/^\/api\/reviews\/(\d+)$/);
  if (reviewMatch && request.method === "DELETE") {
    const result = db.prepare("DELETE FROM reviews WHERE id = ? AND user_id = ?").run(Number(reviewMatch[1]), currentUser.id);
    if (!result.changes) {
      sendError(response, 404, "Review not found.");
      return true;
    }

    sendJson(response, 200, {
      message: "Review deleted.",
      reviews: getReviewRows(db),
      conferences: getConferenceRows(db),
    });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/directory") {
    const query = url.searchParams.get("query") || "";
    sendJson(response, 200, {
      users: getDirectoryRows(db, currentUser.id, query),
    });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/messages") {
    const withUserId = Number(url.searchParams.get("withUserId"));
    if (!Number.isInteger(withUserId) || withUserId <= 0 || !ensureUserExists(db, withUserId)) {
      sendError(response, 400, "Please choose a valid recipient.");
      return true;
    }

    sendJson(response, 200, {
      messages: getMessagesBetweenUsers(db, currentUser.id, withUserId),
    });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/messages") {
    if (hitRateLimit(request, "messages", 40, 60 * 1000)) {
      sendError(response, 429, "You are sending messages too quickly. Please wait a moment and try again.");
      return true;
    }

    const body = await readJsonBody(request);
    const recipientId = Number(body.recipientId);
    const messageBody = cleanText(body.body, 2000);

    if (!Number.isInteger(recipientId) || recipientId <= 0 || recipientId === currentUser.id || !ensureUserExists(db, recipientId)) {
      sendError(response, 400, "Please choose a valid recipient.");
      return true;
    }

    if (!messageBody) {
      sendError(response, 400, "Message text cannot be empty.");
      return true;
    }

    db.prepare(`
      INSERT INTO messages (sender_id, recipient_id, body, created_at)
      VALUES (?, ?, ?, ?)
    `).run(currentUser.id, recipientId, messageBody, nowISO());

    sendJson(response, 201, {
      message: "Message sent.",
      messages: getMessagesBetweenUsers(db, currentUser.id, recipientId),
      users: getDirectoryRows(db, currentUser.id, ""),
    });
    return true;
  }

  if (pathname.startsWith("/api/")) {
    notFound(response);
    return true;
  }

  return false;
}

function serveStatic(response, pathname) {
  const fileName = STATIC_FILES[pathname];
  if (!fileName) {
    notFound(response);
    return;
  }

  const filePath = path.join(ROOT_DIR, fileName);
  const extension = path.extname(filePath);
  const contentType = MIME_TYPES[extension] || "application/octet-stream";

  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendError(response, 500, "Unable to read the requested file.");
      return;
    }

    applySecurityHeaders(response);
    response.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": pathname === "/app.js" || pathname === "/styles.css" ? "no-cache" : "public, max-age=300",
    });
    response.end(content);
  });
}

function createAppServer(options = {}) {
  const db = initializeDatabase(options.rootDir || ROOT_DIR);

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
      const pathname = url.pathname;

      if (pathname.startsWith("/api/")) {
        if (MUTATING_METHODS.has(request.method) && !isAllowedOrigin(request)) {
          sendError(response, 403, "This request origin is not allowed.");
          return;
        }

        const handled = await handleApiRequest(request, response, db, pathname, url);
        if (!handled) {
          notFound(response);
        }
        return;
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        methodNotAllowed(response);
        return;
      }

      if (pathname === "/favicon.ico") {
        response.writeHead(204);
        response.end();
        return;
      }

      serveStatic(response, pathname === "/" ? "/" : pathname);
    } catch (error) {
      console.error(error);
      if (!response.headersSent) {
        sendError(response, 500, "Something went wrong on the server.");
        return;
      }
      response.end();
    }
  });

  return { server, db };
}

if (require.main === module) {
  const port = DEFAULT_PORT;
  const { server } = createAppServer();
  server.listen(port, () => {
    console.log(`MUN Turkey running on http://localhost:${port}`);
  });
}

module.exports = {
  APPLICATION_STATUSES,
  AWARD_TITLES,
  createAppServer,
};
