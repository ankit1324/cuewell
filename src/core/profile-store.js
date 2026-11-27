const fs = require("fs");

// Interview context the Settings window edits, stored in userData/profile.json.
// Field -> maximum length in characters.
const PROFILE_FIELD_LIMITS = Object.freeze({
  role: 200,
  company: 200,
  jobDescription: 20000,
  resume: 20000,
  notes: 20000,
});
const SINGLE_LINE_FIELDS = ["role", "company"];
// Large enough for every field at its limit as escaped JSON.
const MAX_PROFILE_FILE_BYTES = 1024 * 1024;

const FIELD_NAMES = {
  role: "Target role",
  company: "Company",
  jobDescription: "Job description",
  resume: "Resume",
  notes: "Notes",
};

class ProfileValidationError extends Error {
  constructor(field, message) {
    super(message);
    this.field = field;
  }
}

function emptyProfile() {
  const profile = {};
  for (const field of Object.keys(PROFILE_FIELD_LIMITS)) profile[field] = "";
  return profile;
}

/**
 * Check a profile and return a clean copy with every field present. Line
 * endings become \n, control characters other than tab and newline are
 * dropped, values are trimmed, and role/company are kept on one line.
 * Missing or null fields are empty. Throws ProfileValidationError for a
 * non-object, an unknown field, a non-string value or a value over its limit.
 */
function validateProfile(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ProfileValidationError(null, "Interview context must be an object.");
  }
  for (const field of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(PROFILE_FIELD_LIMITS, field)) {
      throw new ProfileValidationError(field, `Unknown interview context field: ${field}.`);
    }
  }
  const clean = emptyProfile();
  for (const [field, limit] of Object.entries(PROFILE_FIELD_LIMITS)) {
    const raw = input[field];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "string") {
      throw new ProfileValidationError(field, `${FIELD_NAMES[field]} must be text.`);
    }
    let value = raw
      .replace(/\r\n?/g, "\n")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
    if (SINGLE_LINE_FIELDS.includes(field)) value = value.replace(/[\n\t]+/g, " ");
    value = value.trim();
    if (value.length > limit) {
      throw new ProfileValidationError(field,
        `${FIELD_NAMES[field]} is too long (${value.length} characters, the limit is ${limit}).`);
    }
    clean[field] = value;
  }
  return clean;
}

/**
 * Read the profile at `filePath`. Returns { profile, error }: a missing file
 * is an empty profile with no error; an unreadable or invalid file is an
 * empty profile with the reason in `error`.
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
    return { profile: validateProfile(JSON.parse(text)), error: null };
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
  ProfileValidationError,
  emptyProfile,
  validateProfile,
  readProfile,
  writeProfile,
};
