import "server-only";

import { normalizeEmail } from "@/lib/email";
import { allowsDomainLevelBlock, domainFromEmail } from "@/lib/outreach/domain";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { HistoricalContact } from "@/lib/types";

/**
 * Server-side reader for imported legacy outreach.
 *
 * This is the other half of the historical import, and the only thing the send
 * path consults besides `outreach_messages`. Two rules are enforced here, and
 * neither is left to a caller:
 *
 *   * **The address is the primary identity.** A match on `email_normalized` is
 *     the strongest answer and is returned first.
 *   * **A domain is a secondary guard, never a shared mailbox.** When the exact
 *     address is unknown, the company domain is checked so `objednavky@bistro.cz`
 *     is not pitched cold after `info@bistro.cz` already was. That lookup is
 *     skipped entirely for `gmail.com`, `seznam.cz`, `outlook.com` and every
 *     other provider, where the domain identifies a person rather than a
 *     company and a block would refuse unrelated businesses.
 *
 * Bounded queries: at most two, regardless of how much history exists. Failures
 * PROPAGATE. This runs inside the send transition, so an unreadable history
 * table must stop the send rather than be mistaken for "no history" — an
 * outreach system that treats "I could not check" as "nothing is on record"
 * fails open, which is the one behaviour this whole guard exists to prevent.
 */

const CONTACT_COLUMNS =
  "email_normalized, domain_normalized, company, contact_count, first_contact_at, last_contact_at, source";

type ContactRow = {
  email_normalized: string | null;
  domain_normalized: string | null;
  company: string | null;
  contact_count: number | null;
  first_contact_at: string | null;
  last_contact_at: string | null;
  source: string | null;
};

function toContact(row: ContactRow, matchedOn: "email" | "domain"): HistoricalContact {
  return {
    matchedOn,
    normalizedEmail: row.email_normalized ?? "",
    normalizedDomain: row.domain_normalized,
    company: row.company,
    contactCount: Number(row.contact_count ?? 1),
    firstContactAt: row.first_contact_at,
    lastContactAt: row.last_contact_at,
    source: row.source ?? "historical_import",
  };
}

/**
 * The imported history for one address, or null when it has none.
 *
 * `rawEmail` is normalized here, so the caller never has to: case, surrounding
 * whitespace and a `Name <addr>` wrapper all resolve to the same stored row.
 */
export async function findHistoricalContact(
  rawEmail: string | null | undefined,
): Promise<HistoricalContact | null> {
  const normalizedEmail = normalizeEmail(rawEmail);
  if (!normalizedEmail) return null;

  const supabase = getSupabaseAdmin();

  // Primary identity: the exact address.
  const { data: byEmail, error: emailError } = await supabase
    .from("historical_outreach")
    .select(CONTACT_COLUMNS)
    .eq("email_normalized", normalizedEmail)
    .maybeSingle();

  // Deliberately not swallowed: see the module note on failing open.
  if (emailError) throw new Error(`historical_outreach lookup failed: ${emailError.message}`);
  if (byEmail) return toContact(byEmail as ContactRow, "email");

  // Secondary identity: the company domain, never a shared mailbox provider.
  const domain = domainFromEmail(normalizedEmail);
  if (!allowsDomainLevelBlock(domain)) return null;

  const { data: byDomain, error: domainError } = await supabase
    .from("historical_outreach")
    .select(CONTACT_COLUMNS)
    .eq("domain_normalized", domain)
    // The generated column makes this a database-level guarantee as well as an
    // application one: provider rows are not even candidates for this lookup.
    .eq("is_shared_provider", false)
    // The exact address was checked above, so it cannot be this row.
    .neq("email_normalized", normalizedEmail)
    // Most recent contact first: that is the one an operator needs told about.
    .order("last_contact_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (domainError) throw new Error(`historical_outreach domain lookup failed: ${domainError.message}`);
  if (!byDomain) return null;

  return toContact(byDomain as ContactRow, "domain");
}