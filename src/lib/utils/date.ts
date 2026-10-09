export function formatDate(dateString: string | null): string {
  if (!dateString) return "—";
  try {
    return new Date(dateString).toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return dateString;
  }
}

export function formatDateTime(dateString: string | null): string {
  if (!dateString) return "—";
  try {
    return new Date(dateString).toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return dateString;
  }
}

export function sequenceLabel(sequenceNumber: number): string {
  if (sequenceNumber <= 0) return "Initial";
  return `Follow-up #${sequenceNumber}`;
}

export function leadTitle(lead: { company_name: string | null; contact_name: string | null; email: string }): string {
  return lead.company_name || lead.contact_name || lead.email;
}

export function draftTitle(draft: { lead: { company_name: string | null; contact_name: string | null; email: string } }): string {
  return leadTitle(draft.lead);
}