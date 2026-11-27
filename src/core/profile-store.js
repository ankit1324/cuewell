const fs = require("fs");

// What the Settings window stores in userData/profile.json: the interview
// context and the About you details. Every field is optional.

// Interview context: field -> maximum length in characters.
const PROFILE_FIELD_LIMITS = Object.freeze({
  role: 200,
  company: 200,
  jobDescription: 20000,
  resume: 20000,
  notes: 20000,
});
// About you free-text fields: field -> maximum length in characters.
const ABOUT_FIELD_LIMITS = Object.freeze({
  fullName: 100,
  preferredName: 60,
  currentTitle: 150,
  currentCompany: 150,
  skills: 500,
  achievements: 4000,
  education: 500,
  location: 150,
  noticePeriod: 100,
  expectedSalary: 100,
  languages: 200,
  answerLanguage: 40,
});
// About you choice fields: field -> allowed values. "" means not set.
const ABOUT_FIELD_CHOICES = Object.freeze({
  relocation: Object.freeze(["yes", "no", "maybe"]),
  tone: Object.freeze(["confident", "friendly", "formal", "concise"]),
});
// Total years of experience: a number from 0 to MAX_YEARS, one decimal at most.
const YEARS_FIELD = "yearsExperience";
const MAX_YEARS = 60;

const TEXT_FIELD_LIMITS = Object.freeze({ ...PROFILE_FIELD_LIMITS, ...ABOUT_FIELD_LIMITS });
// Every field, in the order they are written to profile.json.
const ALL_FIELDS = Object.freeze([
  ...Object.keys(PROFILE_FIELD_LIMITS),
  ...Object.keys(ABOUT_FIELD_LIMITS),
  YEARS_FIELD,
  ...Object.keys(ABOUT_FIELD_CHOICES),
]);
// Text fields that may hold several lines; the rest are kept on one line.
const MULTI_LINE_FIELDS = ["jobDescription", "resume", "notes", "achievements", "education"];
// Large enough for every field at its limit as escaped JSON.
const MAX_PROFILE_FILE_BYTES = 1024 * 1024;

const FIELD_NAMES = {
  role: "Target role",
  company: "Company",
  jobDescription: "Job description",
  resume: "Resume",
  notes: "Notes",
  fullName: "Full name",
  preferredName: "Preferred name",
  currentTitle: "Current title",
  currentCompany: "Current company",
  skills: "Key skills",
  achievements: "Projects and achievements",
  education: "Education",
  location: "Location",
  noticePeriod: "Notice period",
  expectedSalary: "Expected salary",
  languages: "Languages you speak",
  answerLanguage: "Answer in",
  yearsExperience: "Years of experience",
  relocation: "Open to relocation",
  tone: "Tone",
};

const CHOICE_ERRORS = {
  relocation: "Open to relocation must be Yes, No or Maybe.",
  tone: "Tone must be Confident, Friendly, Formal or Concise.",
};
const YEARS_ERROR = `Years of experience must be a number from 0 to ${MAX_YEARS}.`;

class ProfileValidationError extends Error {
  constructor(field, message) {
    super(message);
    this.field = field;
  }
}

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function emptyProfile() {
  const profile = {};
  for (const field of ALL_FIELDS) profile[field] = "";
  return profile;
}

function cleanText(field, raw) {
  if (typeof raw !== "string") {
    throw new ProfileValidationError(field, `${FIELD_NAMES[field]} must be text.`);
  }
  let value = raw
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
  if (!MULTI_LINE_FIELDS.includes(field)) value = value.replace(/[\n\t]+/g, " ");
  value = value.trim();
  const limit = TEXT_FIELD_LIMITS[field];
  if (value.length > limit) {
    throw new ProfileValidationError(field,
      `${FIELD_NAMES[field]} is too long (${value.length} characters, the limit is ${limit}).`);
  }
  return value;
}

/** "5", " 3.5 ", "2,5" (decimal comma) or 7 -> "5" / "3.5" / "2.5" / "7". */
function cleanYears(raw) {
  let number;
  if (typeof raw === "number") {
    number = raw;
  } else if (typeof raw === "string") {
    const text = raw.trim().replace(",", ".");
    if (!text) return "";
    if (!/^\d{1,2}(\.\d)?$/.test(text)) throw new ProfileValidationError(YEARS_FIELD, YEARS_ERROR);
    number = Number(text);
  } else {
    throw new ProfileValidationError(YEARS_FIELD, YEARS_ERROR);
  }
  if (!Number.isFinite(number) || number < 0 || number > MAX_YEARS) {
    throw new ProfileValidationError(YEARS_FIELD, YEARS_ERROR);
  }
  return String(Math.round(number * 10) / 10);
}

function cleanChoice(field, raw) {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : null;
  if (value === "") return "";
  if (value === null || !ABOUT_FIELD_CHOICES[field].includes(value)) {
    throw new ProfileValidationError(field, CHOICE_ERRORS[field]);
  }
  return value;
}

function cleanField(field, raw) {
  if (field === YEARS_FIELD) return cleanYears(raw);
  if (has(ABOUT_FIELD_CHOICES, field)) return cleanChoice(field, raw);
  return cleanText(field, raw);
}

/**
 * Check a profile and return a clean copy with every field present. Line
 * endings become \n, control characters other than tab and newline are
 * dropped, values are trimmed, and single-line fields are kept on one line.
 * Years of experience becomes a plain number as text ("5", "3.5"); choice
 * fields are lowercased. Missing or null fields are empty. Throws
 * ProfileValidationError for a non-object, an unknown field, a value of the
 * wrong type, an invalid choice or number, or a value over its limit.
 */
function validateProfile(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ProfileValidationError(null, "Your details must be an object.");
  }
  for (const field of Object.keys(input)) {
    if (!ALL_FIELDS.includes(field)) {
      throw new ProfileValidationError(field, `Unknown field: ${field}.`);
    }
  }
  const clean = emptyProfile();
  for (const field of ALL_FIELDS) {
    const raw = input[field];
    if (raw === undefined || raw === null) continue;
    clean[field] = cleanField(field, raw);
  }
  return clean;
}

/**
 * Like validateProfile, for a file on disk: unknown fields (for example from
 * a newer version) are ignored, and an invalid field is left empty instead
 * of discarding the rest. Returns { profile, invalid: [field names] }.
 */
function cleanStoredProfile(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ProfileValidationError(null, "profile.json does not hold an object");
  }
  const profile = emptyProfile();
  const invalid = [];
  for (const field of ALL_FIELDS) {
    if (!has(input, field)) continue;
    const raw = input[field];
    if (raw === undefined || raw === null) continue;
    try {
      profile[field] = cleanField(field, raw);
    } catch (error) {
      if (!(error instanceof ProfileValidationError)) throw error;
      invalid.push(field);
    }
  }
  return { profile, invalid };
}

/**
 * Read the profile at `filePath`. Returns { profile, error }: a missing file
 * is an empty profile with no error; an unreadable file or one that is not a
 * JSON object is an empty profile with the reason in `error`. Unknown fields
 * are ignored. Fields with an invalid value are left empty and named in
 * `error`; the other fields still load.
 */
function readProfile(filePath) {
  let text;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { profile: emptyProfile(), error: "profile.json is not a file" };
    if (stat.size > MAX_PROFILE_FILE_BYTES) return { profile: emptyProfile(), error: "profile.json is too large" };
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return { profile: emptyProfile(), error: null };
    return { profile: emptyProfile(), error: error.message };
  }
  try {
    const { profile, invalid } = cleanStoredProfile(JSON.parse(text));
    const error = invalid.length ? `profile.json has invalid values, left empty: ${invalid.join(", ")}` : null;
    return { profile, error };
  } catch (error) {
    return { profile: emptyProfile(), error: error.message };
  }
}

/**
 * Validate `profile` and write it to `filePath` atomically (temp file and
 * rename) with mode 0600. Returns the clean profile that was written. Throws
 * ProfileValidationError for invalid input, or the fs error on failure.
 */
function writeProfile(filePath, profile) {
  const clean = validateProfile(profile);
  const tmpPath = `${filePath}.tmp`;
  // `mode` only applies when the file is created, so a temp file left over
  // from an interrupted write (which keeps its old mode) is removed first.
  try { fs.unlinkSync(tmpPath); } catch (_) { /* normally absent */ }
  const fd = fs.openSync(tmpPath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(clean, null, 2), "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
    throw error;
  }
  try { fs.chmodSync(filePath, 0o600); } catch (_) { /* best effort, e.g. Windows */ }
  return clean;
}

module.exports = {
  PROFILE_FIELD_LIMITS,
  ABOUT_FIELD_LIMITS,
  ABOUT_FIELD_CHOICES,
  YEARS_FIELD,
  MAX_YEARS,
  ALL_FIELDS,
  ProfileValidationError,
  emptyProfile,
  validateProfile,
  readProfile,
  writeProfile,
};
