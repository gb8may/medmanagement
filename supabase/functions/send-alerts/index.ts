import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALERT_WINDOW_MINUTES = 10;

const jsonResponse = (status: number, payload: Record<string, unknown>) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const toMinutes = (time: string) => {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
};

const normalizeScheduleTimes = (
  value: unknown,
  fallbackDose: number
): Array<{ time: string; pills: number }> => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === "string") {
        return { time: entry, pills: fallbackDose };
      }
      if (entry && typeof entry === "object") {
        const maybeEntry = entry as { time?: string; pills?: number };
        if (!maybeEntry.time) return null;
        return {
          time: maybeEntry.time,
          pills: Number(maybeEntry.pills ?? fallbackDose),
        };
      }
      return null;
    })
    .filter((value): value is { time: string; pills: number } => Boolean(value));
};

const getZonedParts = (date: Date, timeZone: string) => {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    dateString: `${map.year}-${map.month}-${map.day}`,
  };
};

const buildAlertKey = (dateString: string, time: string) => `${dateString}-${time}`;

const normalizePhone = (value: string) =>
  value.startsWith("whatsapp:") ? value : `whatsapp:${value}`;

const sendWhatsApp = async (
  accountSid: string,
  authToken: string,
  fromNumber: string,
  to: string,
  message: string
) => {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const body = new URLSearchParams({
    From: normalizePhone(fromNumber),
    To: normalizePhone(to),
    Body: message,
  });
  const auth = btoa(`${accountSid}:${authToken}`);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Twilio error: ${response.status} ${errorText}`);
    }
  } finally {
    clearTimeout(timeoutId);
  }
};

const sendWhatsAppBatch = async (
  accountSid: string,
  authToken: string,
  fromNumber: string,
  phones: string[],
  message: string
) => {
  const tasks = phones.map((phone) =>
    sendWhatsApp(accountSid, authToken, fromNumber, phone, message)
  );
  const results = await Promise.allSettled(tasks);
  const successCount = results.filter((result) => result.status === "fulfilled")
    .length;
  return successCount;
};

type MedRow = {
  id: string;
  user_id: string;
  name: string;
  unit: string;
  dose_amount: number;
  stock: number;
  low_threshold: number;
  schedule_times: unknown;
  alerts_enabled: boolean;
  auto_deduct: boolean;
  last_alert_key: string | null;
  last_auto_dose_key: string | null;
  last_whatsapp_alert_key: string | null;
  last_low_stock_whatsapp_date: string | null;
  profiles?: {
    phone_numbers: string[] | null;
    whatsapp_enabled: boolean | null;
    timezone: string | null;
  } | null;
};

export default async () => {
  const startTime = Date.now();
  const MAX_DURATION_MS = 20_000;
  const MAX_SENDS_PER_RUN = 10;
  const PAGE_SIZE = 50;
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SERVICE_ROLE_KEY");
  const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const authToken = Deno.env.get("TWILIO_AUTH_TOKEN");
  const fromNumber = Deno.env.get("TWILIO_WHATSAPP_FROM");

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse(500, { error: "Missing Supabase credentials." });
  }
  if (!accountSid || !authToken || !fromNumber) {
    return jsonResponse(500, { error: "Missing Twilio credentials." });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const now = new Date();
  let sentCount = 0;
  let updatedCount = 0;
  let offset = 0;
  let done = false;

  while (!done) {
    if (Date.now() - startTime > MAX_DURATION_MS) {
      break;
    }
    if (sentCount >= MAX_SENDS_PER_RUN) {
      break;
    }

    const { data, error } = await supabase
      .from("meds")
      .select(
        `
          id,
          user_id,
          name,
          unit,
          dose_amount,
          stock,
          low_threshold,
          schedule_times,
          alerts_enabled,
          auto_deduct,
          last_alert_key,
          last_auto_dose_key,
          last_whatsapp_alert_key,
          last_low_stock_whatsapp_date,
          profiles:profiles (
            phone_numbers,
            whatsapp_enabled,
            timezone
          )
        `
      )
      .eq("alerts_enabled", true)
      .order("created_at", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      return jsonResponse(500, { error: error.message });
    }

    if (!data || data.length === 0) {
      done = true;
      break;
    }

    for (const med of data as MedRow[]) {
      if (Date.now() - startTime > MAX_DURATION_MS) {
        done = true;
        break;
      }
      if (sentCount >= MAX_SENDS_PER_RUN) {
        done = true;
        break;
      }

      const profile = med.profiles;
      if (!profile || profile.whatsapp_enabled === false) continue;
      const phones = (profile.phone_numbers || []).filter((value) => value?.trim());
      if (!phones.length) continue;
      const scheduleTimes = normalizeScheduleTimes(
        med.schedule_times,
        med.dose_amount || 1
      );
      if (!scheduleTimes.length) continue;

      const timeZone = profile.timezone || "UTC";
      const parts = getZonedParts(now, timeZone);
      const nowMinutes = parts.hour * 60 + parts.minute;

      let newLastWhatsAppKey = med.last_whatsapp_alert_key;
      let newLastAutoDoseKey = med.last_auto_dose_key;
      let newLastTaken = null as string | null;
      let newStock = med.stock;
      let shouldUpdate = false;

      for (const entry of scheduleTimes) {
        const scheduledMinutes = toMinutes(entry.time);
        const diffMinutes = nowMinutes - scheduledMinutes;
        if (diffMinutes < 0 || diffMinutes > ALERT_WINDOW_MINUTES) continue;

        const alertKey = buildAlertKey(parts.dateString, entry.time);
        const doseAmount = Number(entry.pills ?? med.dose_amount ?? 1);
        if (med.last_whatsapp_alert_key !== alertKey) {
          const message = `Hora de tomar ${med.name}. Dose: ${doseAmount} ${med.unit} às ${entry.time}.`;
          sentCount += await sendWhatsAppBatch(
            accountSid,
            authToken,
            fromNumber,
            phones,
            message
          );
          newLastWhatsAppKey = alertKey;
          shouldUpdate = true;
        }

        if (med.auto_deduct && med.last_auto_dose_key !== alertKey) {
          newStock = Math.max(0, newStock - doseAmount);
          newLastTaken = now.toISOString();
          newLastAutoDoseKey = alertKey;
          shouldUpdate = true;
        }
      }

      if (
        med.stock <= med.low_threshold &&
        med.last_low_stock_whatsapp_date !== parts.dateString
      ) {
        const message = `Estoque baixo: ${med.name}. Restam ${med.stock} unidades. Providencie reposição.`;
        sentCount += await sendWhatsAppBatch(
          accountSid,
          authToken,
          fromNumber,
          phones,
          message
        );
        shouldUpdate = true;
      }

      if (shouldUpdate) {
        const updatePayload: Record<string, unknown> = {
          last_whatsapp_alert_key: newLastWhatsAppKey,
          last_auto_dose_key: newLastAutoDoseKey,
        };
        if (newLastTaken) {
          updatePayload.last_taken = newLastTaken;
          updatePayload.stock = newStock;
        }
        if (
          med.stock <= med.low_threshold &&
          med.last_low_stock_whatsapp_date !== parts.dateString
        ) {
          updatePayload.last_low_stock_whatsapp_date = parts.dateString;
        }

        const { error: updateError } = await supabase
          .from("meds")
          .update(updatePayload)
          .eq("id", med.id);
        if (!updateError) {
          updatedCount += 1;
        }
      }
    }

    if (data.length < PAGE_SIZE) {
      done = true;
    } else {
      offset += PAGE_SIZE;
    }
  }

  return jsonResponse(200, { sentCount, updatedCount });
};
