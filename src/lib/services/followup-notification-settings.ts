import "server-only";

import { validateDelayConfig } from "@/lib/followup/notification-delay";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { DelayConfig } from "@/lib/followup/notification-delay";

export type { DelayConfig };

/**
 * Global follow-up notification delay settings.
 *
 * Stored in a singleton table (`followup_notification_settings`). One row,
 * created by the migration. The service reads and updates this row.
 */

export interface NotificationDelaySettings {
  id: string;
  delayValue: number;
  delayUnit: "seconds" | "minutes" | "hours" | "days";
  updatedAt: string;
}

/**
 * Read the current notification delay settings.
 *
 * Returns NULL when the settings table is empty (pre-migration state).
 */
export async function getNotificationDelaySettings(): Promise<NotificationDelaySettings | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("followup_notification_settings")
    .select("id, delay_value, delay_unit, updated_at")
    .limit(1);

  if (error) throw new Error(error.message);
  if (!data || data.length === 0) return null;

  const row = data[0] as Record<string, unknown>;
  return {
    id: String(row.id),
    delayValue: Number(row.delay_value ?? 0),
    delayUnit: row.delay_unit as "seconds" | "minutes" | "hours" | "days",
    updatedAt: String(row.updated_at),
  };
}

/**
 * Read the current delay as a `DelayConfig`, or return the default when the
 * settings row is missing (legacy state) or the table doesn't exist yet
 * (pre-migration).
 */
export async function getNotificationDelayConfig(): Promise<DelayConfig> {
  try {
    const settings = await getNotificationDelaySettings();
    if (!settings) return DEFAULT_DELAY;
    return {
      value: settings.delayValue,
      unit: settings.delayUnit,
    };
  } catch {
    // Table doesn't exist or query failed: return default.
    return DEFAULT_DELAY;
  }
}

/**
 * Update the notification delay settings.
 *
 * Validates the input before writing. Returns the updated settings, or an error
 * describing why the input was rejected.
 */
export async function updateNotificationDelaySettings(input: {
  value: number;
  unit: "seconds" | "minutes" | "hours" | "days";
}): Promise<{ ok: boolean; data: NotificationDelaySettings | null; error: string | null }> {
  if (!validateDelayConfig(input)) {
    return {
      ok: false,
      data: null,
      error: "Invalid delay configuration. Value must be a non-negative integer and unit must be one of: seconds, minutes, hours, days.",
    };
  }

  const supabase = getSupabaseAdmin();

  // Try to update the existing row first.
  const { data: existing, error: existingError } = await supabase
    .from("followup_notification_settings")
    .select("id")
    .limit(1);

  if (existingError) return { ok: false, data: null, error: existingError.message };

  if (existing && existing.length > 0) {
    const { data: updated, error: updateError } = await supabase
      .from("followup_notification_settings")
      .update({ delay_value: input.value, delay_unit: input.unit })
      .eq("id", existing[0].id)
      .select("id, delay_value, delay_unit, updated_at");

    if (updateError) return { ok: false, data: null, error: updateError.message };
    if (!updated || updated.length === 0) return { ok: false, data: null, error: "Settings row not found." };

    const row = updated[0] as Record<string, unknown>;
    return {
      ok: true,
      data: {
        id: String(row.id),
        delayValue: Number(row.delay_value),
        delayUnit: row.delay_unit as "seconds" | "minutes" | "hours" | "days",
        updatedAt: String(row.updated_at),
      },
      error: null,
    };
  }

  // No existing row (pre-migration): insert one.
  const { data: inserted, error: insertError } = await supabase
    .from("followup_notification_settings")
    .insert({ delay_value: input.value, delay_unit: input.unit })
    .select("id, delay_value, delay_unit, updated_at")
    .maybeSingle();

  if (insertError) return { ok: false, data: null, error: insertError.message };
  if (!inserted) return { ok: false, data: null, error: "Settings row could not be created." };

  return {
    ok: true,
    data: {
      id: String(inserted.id),
      delayValue: Number(inserted.delay_value),
      delayUnit: inserted.delay_unit as "seconds" | "minutes" | "hours" | "days",
      updatedAt: String(inserted.updated_at),
    },
    error: null,
  };
}

/** Default delay — used when the settings row is missing (legacy state). */
const DEFAULT_DELAY = { value: 3, unit: "minutes" as const };

export { DEFAULT_DELAY };
