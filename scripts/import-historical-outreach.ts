/**
 * Import the legacy outreach export into `historical_outreach`.
 *
 *   npm run import:historical-outreach              # dry run: parse and report only
 *   npm run import:historical-outreach -- --apply   # write to the database
 *   npm run import:historical-outreach -- --apply --file path/to/export.csv
 *
 * Safety properties, in order of importance:
 *
 *   * **Dry run by default.** Nothing is written without `--apply`. A wrong
 *     export should cost a report, not a table.
 *   * **Idempotent.** The canonical address is the identity, and the unique
 *     constraint on `email_normalized` is the guarantee. Addresses already
 *     imported are skipped, so running this twice inserts nothing the second
 *     time. Existing rows are never updated, so a re-run cannot silently
 *     rewrite history that has since been corrected by hand.
 *   * **No deletion, ever.** This script has no delete path. It does not touch
 *     `leads` or `outreach_messages` at all.
 *   * **Every refusal is fatal.** A row with an unusable address or date is
 *     reported with its line number and stops the run unless every row parsed.
 *     Silently importing 329 of 330 contacts would leave one address unprotected
 *     and nobody would know which one.
 *   * **Verified after writing.** The final block re-reads the table and reports
 *     the stored total, so a partial write is visible rather than assumed away.
 *
 * Plain `node` executes this file, which means no bundler and therefore no
 * `@/…` path alias: the imports below are relative and carry explicit `.ts`
 * extensions, and the modules they reach must stay alias-free.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createClient } from "@supabase/supabase-js";

import {
  parseHistoricalOutreachCsv,
  toHistoricalOutreachRow,
  type HistoricalOutreachInsertRow,
} from "../src/lib/import/historical-outreach.ts";
import { isSharedEmailProviderDomain } from "../src/lib/outreach/domain.ts";

const DEFAULT_FILE = "pepa_outreach_history_detailed.csv";

/** One request, not one row: the export is small but the shape should not matter. */
const BATCH_SIZE = 200;

/* -------------------------------------------------------------------------- */
/* arguments                                                                   */
/* -------------------------------------------------------------------------- */

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function option(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

/* -------------------------------------------------------------------------- */
/* environment                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Load `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` from the local
 * env files when they are not already in the environment.
 *
 * Deliberately a ten-line reader rather than a dotenv dependency: the project
 * takes no new dependencies, and this only has to understand the one file shape
 * Next.js already uses. Values already present in `process.env` win, so a CI run
 * with real environment variables is never overridden by a stale local file.
 */
function loadLocalEnv(): void {
  for (const file of [".env.local", ".env"]) {
    let contents: string;
    try {
      contents = readFileSync(file, "utf8");
    } catch {
      continue;
    }

    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const equals = trimmed.indexOf("=");
      if (equals === -1) continue;
      const key = trimmed.slice(0, equals).trim();
      let value = trimmed.slice(equals + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Add it to .env.local, or export it before running the import.`,
    );
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* reporting                                                                   */
/* -------------------------------------------------------------------------- */

function heading(text: string): void {
  console.log(`\n${text}\n${"-".repeat(text.length)}`);
}

/* -------------------------------------------------------------------------- */
/* main                                                                        */
/* -------------------------------------------------------------------------- */

async function main(): Promise<number> {
  const apply = flag("apply");
  const file = resolve(option("file") ?? DEFAULT_FILE);

  heading("Historical outreach import");
  console.log(`source : ${file}`);
  console.log(`mode   : ${apply ? "APPLY (writes to the database)" : "DRY RUN (nothing is written)"}`);

  /* -- parse ------------------------------------------------------------- */

  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    console.error(`Could not read the export: ${(error as Error).message}`);
    return 1;
  }

  const parsed = parseHistoricalOutreachCsv(text);

  heading("Parsed");
  console.log(`contacts        : ${parsed.contacts.length}`);
  console.log(`rejected rows   : ${parsed.rejections.length}`);
  console.log(`merged in-file  : ${parsed.duplicatesMerged}`);

  const byDomain = new Map<string, number>();
  for (const contact of parsed.contacts) {
    byDomain.set(contact.domain, (byDomain.get(contact.domain) ?? 0) + 1);
  }
  const shared = [...byDomain.entries()].filter(([domain]) => isSharedEmailProviderDomain(domain));
  console.log(`distinct domains: ${byDomain.size}`);
  console.log(
    `provider domains: ${shared.map(([d, n]) => `${d} (${n})`).join(", ") || "none"}`,
  );

  if (parsed.rejections.length > 0) {
    heading("Rejected rows — refusing to continue");
    for (const rejection of parsed.rejections) {
      console.log(`  line ${rejection.line}: ${rejection.email || "(no address)"} — ${rejection.reason}`);
    }
    console.log(
      "\nEvery row must parse. Importing a subset would leave addresses unprotected without saying which.",
    );
    return 1;
  }

  if (parsed.contacts.length === 0) {
    console.error("The export produced no contacts. Nothing to import.");
    return 1;
  }

  /* -- dry run ----------------------------------------------------------- */

  if (!apply) {
    const sample = parsed.contacts.slice(0, 5);
    heading("Sample (dry run — pass --apply to write)");
    for (const contact of sample) {
      console.log(
        `  ${contact.normalizedEmail.padEnd(38)} ${contact.domain.padEnd(24)} ` +
          `${String(contact.contactCount).padStart(3)} contacts  ` +
          `last ${contact.lastContactAt.slice(0, 10)}`,
      );
    }
    console.log(`\n${parsed.contacts.length} contacts are ready. Re-run with --apply to import them.`);
    return 0;
  }

  /* -- connect ----------------------------------------------------------- */

  loadLocalEnv();
  const supabase = createClient(
    requiredEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  /* -- what is already there -------------------------------------------- */

  const existing = new Set<string>();
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("historical_outreach")
      .select("email_normalized")
      .range(offset, offset + 999);
    if (error) {
      console.error(`Could not read existing history: ${error.message}`);
      console.error("Is migration 20260101000600 applied?");
      return 1;
    }
    for (const row of data ?? []) {
      const value = (row as { email_normalized: string | null }).email_normalized;
      if (value) existing.add(value);
    }
    if (!data || data.length < 1000) break;
    offset += 1000;
  }

  heading("Already imported");
  console.log(`rows in table   : ${existing.size}`);

  const fresh = parsed.contacts.filter(
    (contact) => !existing.has(contact.normalizedEmail),
  );

  heading("To insert");
  console.log(`new addresses   : ${fresh.length}`);
  console.log(`already present : ${parsed.contacts.length - fresh.length}`);

  if (fresh.length === 0) {
    console.log("\nNothing to do — the export is fully imported. Re-running is a no-op.");
  }

  /* -- write ------------------------------------------------------------- */

  const rows: HistoricalOutreachInsertRow[] = fresh.map(toHistoricalOutreachRow);

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from("historical_outreach").insert(batch);
    if (error) {
      // 23505 = unique violation. Two concurrent imports can race here, and the
      // constraint turning that race into "already present" is the guarantee
      // working, not a failure.
      if (error.code === "23505") {
        console.error(
          `Batch at offset ${i} hit the unique constraint: ${error.message}. ` +
            `Re-run the import; the addresses are already protected.`,
        );
        return 1;
      }
      console.error(`Insert failed at offset ${i}: ${error.message}`);
      return 1;
    }
    console.log(`  inserted ${Math.min(i + BATCH_SIZE, rows.length)}/${rows.length}`);
  }

  /* -- verify ------------------------------------------------------------ */

  heading("Verification");
  // PostgREST's head+count mode returns no rows and the count in a separate
  // `count` field, so `data` is null here by design.
  const { count: total, error: countError } = await supabase
    .from("historical_outreach")
    .select("id", { count: "exact", head: true });

  if (countError) {
    console.error(`Could not verify: ${countError.message}`);
    return 1;
  }
  console.log(`rows in table now : ${total ?? 0}`);

  const { data: all, error: readError } = await supabase
    .from("historical_outreach")
    .select("email_normalized, domain_normalized, last_contact_at")
    .limit(5000);

  if (readError) {
    console.error(`Could not verify: ${readError.message}`);
    return 1;
  }

  const stored = all ?? [];
  const seen = new Set<string>();
  let duplicates = 0;
  for (const row of stored) {
    const value = (row as { email_normalized: string | null }).email_normalized;
    if (!value) continue;
    if (seen.has(value)) duplicates += 1;
    seen.add(value);
  }

  const missing = parsed.contacts.filter((contact) => !seen.has(contact.normalizedEmail));
  const timestamps = stored
    .map((row) => (row as { last_contact_at?: string }).last_contact_at ?? "")
    .filter(Boolean)
    .sort();

  console.log(`unique addresses  : ${seen.size}`);
  console.log(`duplicates        : ${duplicates}`);
  console.log(`export not stored : ${missing.length}`);
  console.log(`oldest contact    : ${timestamps[0] ? timestamps[0].slice(0, 10) : "—"}`);
  console.log(`newest contact    : ${timestamps[timestamps.length - 1]?.slice(0, 10) ?? "—"}`);

  if (duplicates > 0 || missing.length > 0) {
    console.error("\nVerification FAILED.");
    return 1;
  }

  console.log("\nImport complete and verified.");
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });