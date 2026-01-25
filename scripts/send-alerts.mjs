const ALERT_WINDOW_MINUTES = 10;
const PAGE_SIZE = 200;
const MAX_SENDS_PER_RUN = 50;

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SERVICE_ROLE_KEY;
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_WHATSAPP_FROM;
const templateAlertDose = process.env.TWILIO_TEMPLATE_ALERT_DOSE_SID;
const templateLowStock = process.env.TWILIO_TEMPLATE_LOW_STOCK_SID;

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("Missing SUPABASE_URL or SERVICE_ROLE_KEY.");
}
if (!accountSid || !authToken || !fromNumber) {
  throw new Error("Missing Twilio credentials.");
}
if (!templateAlertDose || !templateLowStock) {
  throw new Error("Missing Twilio template SIDs.");
}

const toMinutes = (time) => {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
};

const normalizeScheduleTimes = (value, fallbackDose = 1) => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === "string") {
        return { time: entry, pills: fallbackDose };
      }
      if (entry && typeof entry === "object") {
        const time = entry.time || "";
        if (!time) return null;
        return {
          time,
          pills: Number(entry.pills ?? fallbackDose),
        };
      }
      return null;
    })
    .filter(Boolean);
};

const getZonedParts = (date, timeZone) => {
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
    hour: Number(map.hour),
    minute: Number(map.minute),
    dateString: `${map.year}-${map.month}-${map.day}`,
  };
};

const buildAlertKey = (dateString, time) => `${dateString}-${time}`;

const normalizePhone = (value) =>
  value.startsWith("whatsapp:") ? value : `whatsapp:${value}`;

const sendWhatsAppTemplate = async (to, contentSid, variables) => {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const body = new URLSearchParams({
    From: normalizePhone(fromNumber),
    To: normalizePhone(to),
    ContentSid: contentSid,
    ContentVariables: JSON.stringify(variables),
  });
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Twilio error: ${response.status} ${text}`);
  }
};

const fetchMedsPage = async (offset) => {
  const url = new URL(`${supabaseUrl}/rest/v1/meds`);
  url.searchParams.set(
    "select",
    [
      "id",
      "user_id",
      "name",
      "unit",
      "dose_amount",
      "stock",
      "low_threshold",
      "schedule_times",
      "alerts_enabled",
      "auto_deduct",
      "last_alert_key",
      "last_auto_dose_key",
      "last_whatsapp_alert_key",
      "last_low_stock_whatsapp_date",
    ].join(",")
  );
  url.searchParams.set("alerts_enabled", "eq.true");
  url.searchParams.set("order", "created_at.desc");
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("limit", String(PAGE_SIZE));

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase error: ${response.status} ${text}`);
  }
  return response.json();
};

const fetchProfiles = async (userIds) => {
  if (!userIds.length) return new Map();
  const chunks = [];
  for (let i = 0; i < userIds.length; i += 100) {
    chunks.push(userIds.slice(i, i + 100));
  }

  const results = await Promise.all(
    chunks.map(async (chunk) => {
      const url = new URL(`${supabaseUrl}/rest/v1/profiles`);
      url.searchParams.set(
        "select",
        "id,full_name,phone_numbers,whatsapp_enabled,timezone"
      );
      url.searchParams.set("id", `in.(${chunk.join(",")})`);
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${serviceRoleKey}`,
          apikey: serviceRoleKey,
        },
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Supabase profiles error: ${response.status} ${text}`);
      }
      return response.json();
    })
  );

  const map = new Map();
  results.flat().forEach((profile) => {
    map.set(profile.id, profile);
  });
  return map;
};

const updateMed = async (medId, payload) => {
  const url = new URL(`${supabaseUrl}/rest/v1/meds`);
  url.searchParams.set("id", `eq.${medId}`);
  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase update error: ${response.status} ${text}`);
  }
};

const run = async () => {
  const now = new Date();
  let offset = 0;
  let sentCount = 0;

  while (sentCount < MAX_SENDS_PER_RUN) {
    const page = await fetchMedsPage(offset);
    if (!page.length) break;
    const userIds = [...new Set(page.map((med) => med.user_id).filter(Boolean))];
    const profiles = await fetchProfiles(userIds);

    for (const med of page) {
      const profile = profiles.get(med.user_id);
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
      let newLastTaken = null;
      let newStock = med.stock;
      let shouldUpdate = false;

      const displayName = profile.full_name || "usuário";

      for (const entry of scheduleTimes) {
        const scheduledMinutes = toMinutes(entry.time);
        const diffMinutes = nowMinutes - scheduledMinutes;
        if (diffMinutes < 0 || diffMinutes > ALERT_WINDOW_MINUTES) continue;

        const alertKey = buildAlertKey(parts.dateString, entry.time);
        const doseAmount = Number(entry.pills ?? med.dose_amount ?? 1);
        if (med.last_whatsapp_alert_key !== alertKey) {
          for (const phone of phones) {
            await sendWhatsAppTemplate(phone, templateAlertDose, {
              "1": displayName,
              "2": med.name,
              "3": String(doseAmount),
              "4": entry.time,
            });
            sentCount += 1;
            if (sentCount >= MAX_SENDS_PER_RUN) break;
          }
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
        for (const phone of phones) {
          await sendWhatsAppTemplate(phone, templateLowStock, {
            "1": displayName,
            "2": med.name,
            "3": String(med.stock),
          });
          sentCount += 1;
          if (sentCount >= MAX_SENDS_PER_RUN) break;
        }
        shouldUpdate = true;
      }

      if (shouldUpdate) {
        const updatePayload = {
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
        await updateMed(med.id, updatePayload);
      }

      if (sentCount >= MAX_SENDS_PER_RUN) break;
    }

    if (page.length < PAGE_SIZE) {
      break;
    }
    offset += PAGE_SIZE;
  }

  console.log(JSON.stringify({ sentCount }));
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
