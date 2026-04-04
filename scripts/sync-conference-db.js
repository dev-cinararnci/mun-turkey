const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const cheerio = require("cheerio");

const ROOT_DIR = path.resolve(__dirname, "..");
const SEED_PATH = path.join(ROOT_DIR, "conference-db.js");
const LIST_ENDPOINT = "https://www.munpoint.com/layout/php/konferans-ara.php";
const LIST_PARAMS = {
  sayfa_dili: "2",
  kelime: "",
  konferanstipi: "",
  sehir: "",
  ulke: "Turkiye",
  komite: "",
  siralama: "1",
  tarihsiralama: "3",
  duzenleyen: "",
  konular: "",
  aytarihsiralama: "0",
  yiltarihsiralama: "0",
  mindelege: "",
  maxdelege: "",
  konferansdili: "0",
  egitimseviyesi: "0",
};
const VERIFIED_DATE = new Date().toISOString().slice(0, 10);
const execFileAsync = promisify(execFile);
const PRESERVE_CURATED_IDS = new Set([
  "atumun-26",
  "tedumun-26",
  "ataeljmun-26",
  "bilkarmun-26",
  "tar-jmun-26",
  "tar-mun-26",
  "munaas-26",
  "sanjmun-26",
  "jnamun-26",
  "tbjmun-26",
  "tbmun-26",
  "tedmun-26",
  "tedcmun-26",
  "fijmun-26",
  "munacs-26",
  "fwwmun-istanbul-26",
]);

function readConferenceSeed(seedPath) {
  const source = fs.readFileSync(seedPath, "utf8");
  const sandbox = { window: {} };
  vm.runInNewContext(source, sandbox, { filename: seedPath });
  return Array.isArray(sandbox.window.CONFERENCE_DB) ? sandbox.window.CONFERENCE_DB : [];
}

function cleanText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function repairTextEncoding(value) {
  const text = String(value || "");
  const repaired = Buffer.from(text, "latin1").toString("utf8");
  const garbledPattern = /[ÃÅâ][^\s]*/g;
  const originalNoise = (text.match(garbledPattern) || []).length;
  const repairedNoise = (repaired.match(garbledPattern) || []).length;
  return repairedNoise < originalNoise ? repaired : text;
}

function normalizeUrl(href) {
  if (!href) {
    return "";
  }

  try {
    return new URL(href, "https://www.munpoint.com").href;
  } catch (error) {
    return "";
  }
}

function extractSlug(url) {
  if (!url) {
    return "";
  }

  try {
    const pathname = new URL(url).pathname.replace(/\/+$/, "");
    const segments = pathname.split("/").filter(Boolean);
    const munsIndex = segments.indexOf("muns");
    if (munsIndex < 0 || !segments[munsIndex + 1]) {
      return "";
    }

    return segments[munsIndex + 1];
  } catch (error) {
    return "";
  }
}

function parseIsoDate(value) {
  const match = cleanText(value).match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (!match) {
    return "";
  }

  return `${match[3]}-${match[2]}-${match[1]}`;
}

function parseDateRange(value) {
  const matches = cleanText(value).match(/\d{2}\.\d{2}\.\d{4}/g) || [];
  const startValue = matches[0] || "";
  const endValue = matches[1] || startValue;

  return {
    startDate: parseIsoDate(startValue),
    endDate: parseIsoDate(endValue),
  };
}

function normalizeCity(value) {
  const text = cleanText(value)
    .replace(/,\s*(Türkiye|Turkiye)$/i, "")
    .replace(/\s+Province$/i, "");

  return text || "Online";
}

function normalizeEducationLevel(value) {
  const text = cleanText(value).toLowerCase();
  const map = {
    "elementary school": "Elementary School",
    "primary school": "Elementary School",
    "primary (basic)": "Elementary School",
    "middle school": "Middle School",
    "high school": "High School",
    university: "University",
    ilkokul: "Elementary School",
    "ilkokul (temel)": "Elementary School",
    ortaokul: "Middle School",
    lise: "High School",
    "yüksek okul": "University",
    üniversite: "University",
  };

  return map[text] || text.replace(/\b\w/g, (character) => character.toUpperCase());
}

function parseEducationLevels(value) {
  return [...new Set(
    cleanText(value)
      .split(",")
      .map((item) => normalizeEducationLevel(item))
      .filter(Boolean),
  )];
}

function inferFormats({ shortName, name, educationLevels }) {
  const text = cleanText(`${shortName} ${name}`).toLowerCase();
  const formats = new Set();

  if (
    text.includes("jmun") ||
    text.includes("junior") ||
    educationLevels.includes("Elementary School") ||
    educationLevels.includes("Middle School")
  ) {
    formats.add("JMUN");
  }

  if (
    educationLevels.includes("High School") ||
    educationLevels.includes("University") ||
    (text.includes("mun") && !text.includes("bmun"))
  ) {
    formats.add("MUN");
  }

  if (!formats.size) {
    formats.add("MUN");
  }

  return [...formats];
}

function shortenText(value, maxLength) {
  const text = cleanText(value);
  if (text.length <= maxLength) {
    return text;
  }

  const sentence = text.match(new RegExp(`^.{1,${maxLength}}(?:[.!?](?=\\s|$))`));
  if (sentence && sentence[0].length >= 24) {
    return cleanText(sentence[0]);
  }

  return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}...`;
}

function summarizeCommittee(text) {
  const cleaned = cleanText(text)
    .replace(/\b(Co-?Chair|Chair|Vice-?Chair|President|Vice President|Rapporteur|Director|Moderator)\s*:\s*[^.]+/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  return shortenText(cleaned, 220);
}

function summarizeFees(items) {
  if (!items.length) {
    return "See public listing";
  }

  const preferredLabels = [
    "Conference Fee",
    "Conference Delegation Fee",
    "Application Delegate Fee",
    "Application Head Delegate Fee",
    "Application Head Delege Fee",
    "Head Delegate Fee",
    "Delegate Fee",
  ];

  for (const label of preferredLabels) {
    const match = items.find((item) => item.label === label);
    if (match) {
      return `${match.label} ${match.value}`;
    }
  }

  return items
    .slice(0, 3)
    .map((item) => `${item.label} ${item.value}`)
    .join("; ");
}

function formatLevelSummary(levels) {
  if (!levels.length) {
    return "delegates";
  }

  if (levels.length === 1) {
    return `${levels[0].toLowerCase()} delegates`;
  }

  if (levels.length === 2) {
    return `${levels[0].toLowerCase()} and ${levels[1].toLowerCase()} delegates`;
  }

  return `${levels.slice(0, -1).map((item) => item.toLowerCase()).join(", ")}, and ${
    levels[levels.length - 1].toLowerCase()
  } delegates`;
}

function buildDescription(conference) {
  const locationText = conference.city === "Online" ? "online" : `in ${conference.city}`;
  const levelSummary = formatLevelSummary(conference.educationLevels);
  const attendanceSummary = conference.delegates
    ? `${conference.delegates} delegates listed on the public record`
    : "delegate capacity listed on the public record";
  const formatSummary = conference.formats.join(" / ");

  return shortenText(
    `${conference.name} is listed on MUNPoint as a ${conference.language} ${formatSummary} conference ${locationText} for ${levelSummary}, with ${attendanceSummary}.`,
    240,
  );
}

function parseCardListings(html) {
  const $ = cheerio.load(html);
  const listings = new Map();
  const applyLinks = new Map();

  $('a[href*="/muns/"]').each((_, element) => {
    const anchor = $(element);
    const href = normalizeUrl(anchor.attr("href"));
    const slug = extractSlug(href);
    const text = cleanText(anchor.text());
    if (!slug || !href) {
      return;
    }

    if (/\/(guest-apply|misafir-basvurusu)$/i.test(href)) {
      applyLinks.set(slug, href);
      return;
    }

    if (!anchor.find(".konferans_box_list_tamadi").length || listings.has(slug)) {
      return;
    }

    const details = anchor
      .find(".konferans_box_list_detay")
      .map((__, node) => cleanText($(node).text()))
      .get()
      .filter(Boolean);

    listings.set(slug, {
      id: slug,
      url: href,
      shortName: cleanText(anchor.find(".konferans_box_list_adi").first().text()),
      name: cleanText(anchor.find(".konferans_box_list_tamadi").first().text()) || text,
      locationText: details[0] || "",
      dateText: details[1] || "",
      delegatesText: details.find((item) => /\d+/.test(item)) || "",
    });
  });

  return { listings, applyLinks };
}

function extractBoxValue($, element) {
  const node = $(element).clone();
  node.find("i").remove();
  const label = cleanText(node.children("div").first().text());
  node.children("div").first().remove();
  const value = cleanText(node.text());
  return { label, value };
}

function parseDetailPage(listing, applyLinks, html) {
  const $ = cheerio.load(html);
  const detailBoxes = $(".konferans_box_detay-multi")
    .not(".konferans_box_detay-multi-fiyat")
    .map((_, element) => extractBoxValue($, element))
    .get();
  const details = Object.fromEntries(detailBoxes.map((item) => [item.label, item.value]));
  const feeItems = $(".konferans_box_detay-multi-fiyat")
    .map((_, element) => extractBoxValue($, element))
    .get()
    .filter((item) => item.label && item.value);
  const committees = [];

  $(".komite_adi").each((_, element) => {
    const container = $(element).closest(".resimAreaRight");
    const paragraphs = container
      .find(".komite_konular p")
      .map((__, paragraph) => cleanText($(paragraph).text()))
      .get()
      .filter(Boolean);
    const topic = summarizeCommittee(paragraphs[0] || container.find(".komite_konular").text());
    const committeeName = cleanText($(element).text());

    if (committeeName) {
      committees.push({
        name: committeeName,
        topic: topic || "Topic not listed on the public record.",
      });
    }
  });

  const socialLinks = $(".konferans_social_box a[href]")
    .map((_, element) => ({
      label: cleanText($(element).find(".konferans_social_box_name").text()) || cleanText($(element).text()),
      url: normalizeUrl($(element).attr("href")),
    }))
    .get()
    .filter((item) => item.label && item.url && !item.url.includes("munpoint.com/layout/images"));
  const conferenceDates = parseDateRange(details["Conference Date"] || listing.dateText);
  const applicationDates = parseDateRange(details["Application Date"]);
  const educationLevels = parseEducationLevels(details["Education Level"]);
  const delegates = Number.parseInt(
    cleanText(details["Delegates Number"] || listing.delegatesText).replace(/[^\d]/g, ""),
    10,
  );
  const city = normalizeCity(details.Address || listing.locationText);
  const conference = {
    id: listing.id,
    shortName: cleanText($("h1.baslik").first().text()) || listing.shortName,
    name: listing.name,
    city,
    startDate: conferenceDates.startDate,
    endDate: conferenceDates.endDate,
    applyStart: applicationDates.startDate || conferenceDates.startDate,
    applyEnd: applicationDates.endDate || conferenceDates.startDate,
    delegates: Number.isFinite(delegates) ? delegates : 0,
    language: cleanText(details["Conference Language"]) || "English",
    educationLevels,
    formats: [],
    fees: summarizeFees(feeItems),
    description: "",
    committees,
    applicationLink: applyLinks.get(listing.id) || listing.url,
    sourceLabel: "MUNPoint",
    sourceUrl: listing.url,
    officialUrl: "",
    socialLinks,
    lastVerified: VERIFIED_DATE,
  };

  conference.formats = inferFormats(conference);
  conference.description = buildDescription(conference);

  return conference;
}

async function fetchText(url, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const headers = {
    "user-agent": "MUN Turkey Conference Sync/1.0",
    "accept-language": "en-US,en;q=0.9,tr;q=0.8",
    ...(options.headers || {}),
  };
  const args = [
    "--silent",
    "--show-error",
    "--location",
    "--compressed",
    "--http1.1",
    "--max-time",
    "45",
  ];

  if (method === "POST") {
    args.push("--request", "POST");
  }

  for (const [key, value] of Object.entries(headers)) {
    if (!value) {
      continue;
    }

    args.push("--header", `${key}: ${value}`);
  }

  if (options.body) {
    args.push("--data", String(options.body));
  }

  args.push(url);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const { stdout } = await execFileAsync("curl.exe", args, {
        cwd: ROOT_DIR,
        maxBuffer: 15 * 1024 * 1024,
        encoding: "buffer",
      });
      return repairTextEncoding(Buffer.from(stdout).toString("utf8"));
    } catch (error) {
      if (attempt === 3) {
        throw new Error(error.stderr ? cleanText(error.stderr) : error.message);
      }

      await wait(attempt * 1500);
    }
  }
}

async function mapConcurrent(items, concurrency, mapper) {
  const results = new Array(items.length);
  let currentIndex = 0;

  async function worker() {
    while (currentIndex < items.length) {
      const index = currentIndex;
      currentIndex += 1;

      try {
        results[index] = await mapper(items[index], index);
      } catch (error) {
        results[index] = null;
        console.error(`[sync] ${items[index].id || index}: ${error.message}`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => worker()),
  );
  return results;
}

function compareConferences(left, right) {
  return (
    String(left.startDate || "").localeCompare(String(right.startDate || "")) ||
    String(left.endDate || "").localeCompare(String(right.endDate || "")) ||
    String(left.shortName || "").localeCompare(String(right.shortName || ""))
  );
}

function wait(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function main() {
  const existingConferences = readConferenceSeed(SEED_PATH);
  const listHtml = await fetchText(LIST_ENDPOINT, {
    method: "POST",
    headers: {
      referer: "https://www.munpoint.com/tr/mun-konferans-listesi",
    },
    body: new URLSearchParams(LIST_PARAMS),
  });
  const { listings, applyLinks } = parseCardListings(listHtml);
  const listingItems = [...listings.values()];

  if (!listingItems.length) {
    throw new Error("No Turkey conference listings were returned by MUNPoint.");
  }

  const importedConferences = (await mapConcurrent(listingItems, 4, async (listing) => {
    const detailHtml = await fetchText(listing.url);
    return parseDetailPage(listing, applyLinks, detailHtml);
  })).filter(Boolean);

  const merged = new Map(
    existingConferences
      .filter((conference) => PRESERVE_CURATED_IDS.has(conference.id))
      .map((conference) => [conference.id, conference]),
  );
  let addedCount = 0;
  let refreshedCount = 0;
  let skippedCount = 0;

  for (const conference of importedConferences) {
    if (PRESERVE_CURATED_IDS.has(conference.id)) {
      skippedCount += 1;
      continue;
    }

    if (existingConferences.some((item) => item.id === conference.id)) {
      refreshedCount += 1;
    } else {
      addedCount += 1;
    }

    merged.set(conference.id, conference);
  }

  const conferences = [...merged.values()].sort(compareConferences);
  fs.writeFileSync(SEED_PATH, `window.CONFERENCE_DB = ${JSON.stringify(conferences, null, 2)};\n`);

  console.log(
    `Imported ${importedConferences.length} MUNPoint Turkey records, added ${addedCount} new conferences, refreshed ${refreshedCount} generated records, skipped ${skippedCount} curated records, total ${conferences.length}.`,
  );
}

main().catch((error) => {
  console.error(`[sync] ${error.message}`);
  process.exitCode = 1;
});
