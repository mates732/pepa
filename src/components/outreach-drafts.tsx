import type { OutreachMessage } from "@/lib/types";

export interface OutreachDraftItem {
  message: OutreachMessage;
  lead: {
    id: string;
    email: string;
    company_name: string | null;
    contact_name: string | null;
  };
}

interface OutreachDraftsProps {
  drafts: OutreachDraftItem[];
  loading: boolean;
  error: string | null;
  openingId: string | null;
  deletingId: string | null;
  onOpen: (messageId: string) => void;
  onGmail: (messageId: string) => void;
  onDelete: (messageId: string) => void;
}

function sequenceLabel(sequenceNumber: number): string {
  if (sequenceNumber <= 0) return "Initial";
  return `Follow-up #${sequenceNumber}`;
}

function draftTitle(draft: OutreachDraftItem): string {
  return draft.lead.company_name || draft.lead.contact_name || draft.lead.email;
}

export function OutreachDrafts({
  drafts,
  loading,
  error,
  openingId,
  deletingId,
  onOpen,
  onGmail,
  onDelete,
}: OutreachDraftsProps) {
  return (
    <section className="sticker">
      <div className="sticker-title-row">
        <h2 className="sticker-title">Drafts ({drafts.length})</h2>
      </div>

      {loading ? (
        <p className="m-5 rounded-[1.25rem] border-[3px] border-dashed border-midnight-line bg-midnight-faint/40 px-5 py-8 text-center text-sm font-semibold text-midnight-soft">
          Loading drafts…
        </p>
      ) : error ? (
        <p className="m-5 rounded-[1.25rem] border-[3px] border-red-300 bg-red-50/80 px-5 py-4 text-sm font-semibold text-red-700">
          {error}
        </p>
      ) : drafts.length === 0 ? (
        <p className="m-5 rounded-[1.25rem] border-[3px] border-dashed border-midnight-line bg-midnight-faint/40 px-5 py-8 text-center text-sm font-semibold text-midnight-soft">
          No drafts yet.
        </p>
      ) : (
        <ul className="divide-y divide-midnight-line/40">
          {drafts.map((draft) => {
            const title = draftTitle(draft);
            const isOpening = openingId === draft.message.id;
            const isDeleting = deletingId === draft.message.id;

            return (
              <li key={draft.message.id} className="px-5 py-4">
                <p className="text-sm font-semibold text-midnight-ink">{title}</p>
                <p className="text-xs text-midnight-soft">{draft.message.recipient_email}</p>
                <p className="mt-1 text-sm text-midnight-ink">{draft.message.subject || "(No subject)"}</p>
                <p className="mt-1 text-xs font-semibold text-midnight-soft">
                  {sequenceLabel(draft.message.sequence_number)}
                </p>

                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => onOpen(draft.message.id)}
                    disabled={isOpening || isDeleting}
                  >
                    {isOpening ? "Opening…" : "Open"}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => onGmail(draft.message.id)}
                    disabled={isOpening || isDeleting}
                  >
                    Gmail
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => onDelete(draft.message.id)}
                    disabled={isDeleting || isOpening}
                  >
                    {isDeleting ? "Deleting…" : "Delete"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export { sequenceLabel as outreachDraftSequenceLabel };

export function outreachDraftActionIds(messageId: string): {
  open: string;
  gmail: string;
  del: string;
} {
  return { open: messageId, gmail: messageId, del: messageId };
}
