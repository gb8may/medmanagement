import { useEffect, useMemo, useState } from "react";
import { isSupabaseConfigured, supabase } from "./supabase";

const STORAGE_KEY = "medmanager:meds";
const SETTINGS_KEY = "medmanager:settings";
const USER_KEY = "medwatch:user";
const ALERT_WINDOW_MINUTES = 10;
const WHATSAPP_ENDPOINT = "/.netlify/functions/send-whatsapp";

const sampleMeds = [];

const defaultForm = {
  name: "",
  dosage: "",
  unit: "mg",
  doseAmount: 1,
  stock: 30,
  lowThreshold: 5,
  scheduleTimes: ["08:00"],
  alertsEnabled: true,
  autoDeduct: false,
  notes: "",
};

const defaultUser = {
  fullName: "",
  email: "",
  phoneNumbers: ["", "", ""],
  password: "",
  timezone: "UTC",
};

const defaultUserState = {
  id: "",
  fullName: "",
  email: "",
  phoneNumbers: ["", "", ""],
  timezone: "UTC",
  whatsappEnabled: true,
};

const toDbUser = (user, userId, username, whatsappEnabled, timezone) => ({
  id: userId,
  username,
  full_name: user.fullName,
  email: user.email,
  phone_numbers: user.phoneNumbers,
  whatsapp_enabled: whatsappEnabled,
  timezone,
});

const fromDbUser = (row) => ({
  id: row.id,
  username: row.username ?? "",
  fullName: row.full_name ?? "",
  email: row.email ?? "",
  phoneNumbers: row.phone_numbers ?? ["", "", ""],
  whatsappEnabled: row.whatsapp_enabled ?? true,
  timezone: row.timezone ?? "UTC",
});

const normalizeUsername = (value) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();

const buildAuthEmail = (username) => `${username}@medwatch.local`;

const toDbMed = (med, userId) => ({
  user_id: userId,
  name: med.name,
  dosage: med.dosage,
  unit: med.unit,
  dose_amount: med.doseAmount,
  stock: med.stock,
  low_threshold: med.lowThreshold,
  schedule_times: med.scheduleTimes,
  alerts_enabled: med.alertsEnabled,
  auto_deduct: med.autoDeduct,
  notes: med.notes,
  last_taken: med.lastTaken,
  last_alert_key: med.lastAlertKey,
  last_auto_dose_key: med.lastAutoDoseKey,
  last_whatsapp_alert_key: med.lastWhatsappAlertKey,
  last_low_stock_whatsapp_date: med.lastLowStockWhatsappDate,
});

const fromDbMed = (row) => ({
  id: row.id,
  name: row.name ?? "",
  dosage: row.dosage ?? "",
  unit: row.unit ?? "mg",
  doseAmount: row.dose_amount ?? 1,
  stock: row.stock ?? 0,
  lowThreshold: row.low_threshold ?? 0,
  scheduleTimes: row.schedule_times ?? [],
  alertsEnabled: row.alerts_enabled ?? true,
  autoDeduct: row.auto_deduct ?? false,
  notes: row.notes ?? "",
  lastTaken: row.last_taken ?? null,
  lastAlertKey: row.last_alert_key ?? null,
  lastAutoDoseKey: row.last_auto_dose_key ?? null,
  lastWhatsappAlertKey: row.last_whatsapp_alert_key ?? null,
  lastLowStockWhatsappDate: row.last_low_stock_whatsapp_date ?? null,
});

const formatDateTime = (value) => {
  if (!value) return "Ainda não registrado";
  const date = new Date(value);
  return date.toLocaleString("pt-BR");
};

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const buildAlertKey = (date, time) => `${date}-${time}`;

const getTodayString = (date) => date.toISOString().slice(0, 10);

const parseTimeToDate = (baseDate, time) => {
  const [hours, minutes] = time.split(":").map((value) => Number(value));
  const date = new Date(baseDate);
  date.setHours(hours, minutes, 0, 0);
  return date;
};

const getNextDose = (scheduleTimes) => {
  if (!scheduleTimes?.length) return null;
  const now = new Date();
  const times = [...scheduleTimes].sort();
  for (const time of times) {
    const candidate = parseTimeToDate(now, time);
    if (candidate >= now) {
      return candidate;
    }
  }
  return parseTimeToDate(new Date(now.getTime() + 24 * 60 * 60 * 1000), times[0]);
};

const computeAlerts = (meds, now) => {
  const today = getTodayString(now);
  const dueAlerts = [];
  let changed = false;
  const updatedMeds = meds.map((med) => {
    if (!med.alertsEnabled || !med.scheduleTimes?.length) {
      return med;
    }

    let lastAlertKey = med.lastAlertKey;
    med.scheduleTimes.forEach((time) => {
      const scheduledTime = parseTimeToDate(now, time);
      const diffMinutes = (now - scheduledTime) / 60000;
      if (diffMinutes >= 0 && diffMinutes <= ALERT_WINDOW_MINUTES) {
        const alertKey = buildAlertKey(today, time);
        if (lastAlertKey !== alertKey) {
          lastAlertKey = alertKey;
          dueAlerts.push({
            medId: med.id,
            name: med.name,
            time,
            doseAmount: med.doseAmount,
            unit: med.unit,
            alertKey,
          });
        }
      }
    });

    if (lastAlertKey !== med.lastAlertKey) {
      changed = true;
      return { ...med, lastAlertKey };
    }

    return med;
  });

  return {
    dueAlerts,
    updatedMeds: changed ? updatedMeds : null,
  };
};

const applyAutoDoses = (meds, dueAlerts, now) => {
  if (!dueAlerts.length) {
    return { updatedMeds: null, changedIds: [] };
  }
  const alertsByMed = dueAlerts.reduce((acc, alert) => {
    if (!acc[alert.medId]) {
      acc[alert.medId] = [];
    }
    acc[alert.medId].push(alert);
    return acc;
  }, {});

  const updatedMeds = meds.map((med) => {
    if (!med.autoDeduct) return med;
    const alerts = alertsByMed[med.id] || [];
    if (!alerts.length) return med;

    let lastAutoDoseKey = med.lastAutoDoseKey ?? null;
    let stock = med.stock;
    let lastTaken = med.lastTaken;

    alerts.forEach((alert) => {
      if (alert.alertKey && alert.alertKey !== lastAutoDoseKey) {
        stock = Math.max(0, stock - med.doseAmount);
        lastTaken = now.toISOString();
        lastAutoDoseKey = alert.alertKey;
      }
    });

    if (
      lastAutoDoseKey !== med.lastAutoDoseKey ||
      stock !== med.stock ||
      lastTaken !== med.lastTaken
    ) {
      return { ...med, stock, lastTaken, lastAutoDoseKey };
    }

    return med;
  });

  const changedIds = updatedMeds
    .filter((med, index) => med !== meds[index])
    .map((med) => med.id);

  return { updatedMeds, changedIds };
};

const buildDoseWhatsApp = (alert) =>
  `Hora de tomar ${alert.name}. Dose: ${alert.doseAmount} ${alert.unit} às ${alert.time}.`;

const buildLowStockWhatsApp = (med) =>
  `Estoque baixo: ${med.name}. Restam ${med.stock} unidades. Providencie reposição.`;

const computeWhatsappQueue = (meds, dueAlerts, now) => {
  const today = getTodayString(now);
  const alertsByMed = dueAlerts.reduce((acc, alert) => {
    if (!acc[alert.medId]) {
      acc[alert.medId] = [];
    }
    acc[alert.medId].push(alert);
    return acc;
  }, {});

  let changed = false;
  const queue = [];
  const updatedMeds = meds.map((med) => {
    if (!med.alertsEnabled) return med;

    let lastWhatsappAlertKey = med.lastWhatsappAlertKey ?? null;
    let lastLowStockWhatsappDate = med.lastLowStockWhatsappDate ?? null;

    const medAlerts = alertsByMed[med.id] || [];
    medAlerts.forEach((alert) => {
      if (alert.alertKey && alert.alertKey !== lastWhatsappAlertKey) {
        queue.push(buildDoseWhatsApp(alert));
        lastWhatsappAlertKey = alert.alertKey;
      }
    });

    if (med.stock <= med.lowThreshold && lastLowStockWhatsappDate !== today) {
      queue.push(buildLowStockWhatsApp(med));
      lastLowStockWhatsappDate = today;
    }

    if (
      lastWhatsappAlertKey !== med.lastWhatsappAlertKey ||
      lastLowStockWhatsappDate !== med.lastLowStockWhatsappDate
    ) {
      changed = true;
      return { ...med, lastWhatsappAlertKey, lastLowStockWhatsappDate };
    }

    return med;
  });

  return {
    queue,
    updatedMeds: changed ? updatedMeds : null,
  };
};

export default function App() {
  const [meds, setMeds] = useState(sampleMeds);
  const [form, setForm] = useState(defaultForm);
  const [user, setUser] = useState(defaultUserState);
  const [userForm, setUserForm] = useState(defaultUser);
  const [showProfileForm, setShowProfileForm] = useState(true);
  const [alerts, setAlerts] = useState([]);
  const [tick, setTick] = useState(Date.now());
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [whatsappEnabled, setWhatsappEnabled] = useState(true);
  const [phoneNumbers, setPhoneNumbers] = useState(["", "", ""]);
  const [isLoadingMeds, setIsLoadingMeds] = useState(false);
  const [cloudError, setCloudError] = useState("");
  const [authError, setAuthError] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [whatsappStatus, setWhatsappStatus] = useState("idle");

  const hasProfile = Boolean(user.id);
  const cloudEnabled = Boolean(isSupabaseConfigured && supabase);

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    const settings = localStorage.getItem(SETTINGS_KEY);

    if (saved && !cloudEnabled) {
      try {
        const parsed = JSON.parse(saved);
        setMeds(parsed);
      } catch {
        setMeds(sampleMeds);
      }
    }

    if (settings) {
      try {
        const parsed = JSON.parse(settings);
        setNotificationsEnabled(Boolean(parsed.notificationsEnabled));
        setWhatsappEnabled(Boolean(parsed.whatsappEnabled));
        setPhoneNumbers(parsed.phoneNumbers || ["", "", ""]);
      } catch {
        setNotificationsEnabled(false);
        setWhatsappEnabled(false);
        setPhoneNumbers(["", "", ""]);
      }
    }

    if (!cloudEnabled) {
      const savedUser = localStorage.getItem(USER_KEY);
      if (savedUser) {
        try {
          const parsed = JSON.parse(savedUser);
          setUser(parsed);
          setUserForm({
            fullName: parsed.fullName || "",
            email: parsed.email || "",
            phoneNumbers: parsed.phoneNumbers || ["", "", ""],
            password: "",
            timezone: parsed.timezone || "UTC",
          });
          setShowProfileForm(!parsed.id);
        } catch {
          setUser(defaultUserState);
          setUserForm(defaultUser);
        }
      }
    }
  }, [cloudEnabled]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(meds));
  }, [meds]);

  useEffect(() => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ notificationsEnabled, whatsappEnabled, phoneNumbers })
    );
  }, [notificationsEnabled, whatsappEnabled, phoneNumbers]);

  useEffect(() => {
    if (!cloudEnabled) {
      localStorage.setItem(USER_KEY, JSON.stringify(user));
    }
  }, [cloudEnabled, user]);

  useEffect(() => {
    if (!cloudEnabled) return;

    const initSession = async () => {
      const { data } = await supabase.auth.getSession();
      if (data.session?.user) {
        setUser((prev) => ({ ...prev, id: data.session.user.id }));
        setUserForm((prev) => ({
          ...prev,
          email: data.session.user.email || prev.email,
        }));
        setShowProfileForm(false);
      }
    };

    initSession();

    const { data: authListener } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        if (session?.user) {
          setUser((prev) => ({ ...prev, id: session.user.id }));
          setUserForm((prev) => ({
            ...prev,
            email: session.user.email || prev.email,
          }));
        } else {
          setUser(defaultUserState);
          setMeds([]);
          setShowProfileForm(true);
        }
      }
    );

    return () => {
      authListener?.subscription?.unsubscribe();
    };
  }, [cloudEnabled]);

  useEffect(() => {
    const loadUserFromCloud = async () => {
      if (!cloudEnabled || !user.id) return;
      try {
        const { data, error } = await supabase
          .from("profiles")
          .select("*")
          .eq("id", user.id)
          .maybeSingle();

        if (error) throw error;
        if (!data) {
          setShowProfileForm(true);
          return;
        }
        const updatedUser = fromDbUser(data);
        setUser(updatedUser);
        setUserForm({
          fullName: updatedUser.fullName,
          email: updatedUser.email,
          phoneNumbers: updatedUser.phoneNumbers,
          password: "",
          timezone: updatedUser.timezone || "UTC",
        });
        setPhoneNumbers(updatedUser.phoneNumbers ?? ["", "", ""]);
        setWhatsappEnabled(updatedUser.whatsappEnabled ?? true);
      } catch {
        setCloudError("Não foi possível carregar o perfil compartilhado.");
      }
    };

    loadUserFromCloud();
  }, [cloudEnabled, user.id]);

  useEffect(() => {
    const loadMedsFromCloud = async () => {
      if (!cloudEnabled || !user.id) return;
      setIsLoadingMeds(true);
      try {
        const { data, error } = await supabase
          .from("meds")
          .select("*")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false });

        if (error) throw error;
        setMeds(data.map(fromDbMed));
        setCloudError("");
      } catch {
        setCloudError("Não foi possível carregar as medicações compartilhadas.");
      } finally {
        setIsLoadingMeds(false);
      }
    };

    loadMedsFromCloud();
  }, [cloudEnabled, user.id]);

  useEffect(() => {
    const interval = setInterval(() => {
      setTick(Date.now());
    }, 60000);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const now = new Date(tick);
    const { dueAlerts, updatedMeds } = computeAlerts(meds, now);
    const baseMeds = updatedMeds ?? meds;
    setAlerts(dueAlerts);

    if (notificationsEnabled && dueAlerts.length) {
      dueAlerts.forEach((alert) => {
        new Notification(`Hora de tomar ${alert.name}`, {
          body: `Dose: ${alert.doseAmount} ${alert.unit} às ${alert.time}.`,
        });
      });
    }

    if (dueAlerts.length) {
      const { updatedMeds: autoUpdatedMeds, changedIds } = applyAutoDoses(
        baseMeds,
        dueAlerts,
        now
      );
      if (autoUpdatedMeds) {
        setMeds(autoUpdatedMeds);
        if (cloudEnabled && changedIds.length) {
          changedIds.forEach((medId) => {
            const updated = autoUpdatedMeds.find((med) => med.id === medId);
            if (!updated) return;
            updateMedInCloud(medId, updated).catch(() => {
              setCloudError("Não foi possível atualizar doses automáticas.");
            });
          });
        }
      } else if (updatedMeds) {
        setMeds(updatedMeds);
      }
    } else if (updatedMeds) {
      setMeds(updatedMeds);
    }

    const activePhoneNumbers = phoneNumbers.filter((value) => value.trim());
    if (!cloudEnabled && whatsappEnabled && activePhoneNumbers.length) {
      const { queue, updatedMeds: whatsappUpdatedMeds } = computeWhatsappQueue(
        baseMeds,
        dueAlerts,
        now
      );
      if (whatsappUpdatedMeds) {
        setMeds(whatsappUpdatedMeds);
      } else if (updatedMeds) {
        setMeds(updatedMeds);
      }

      if (queue.length) {
        const sendQueue = async () => {
          for (const message of queue) {
            for (const to of activePhoneNumbers) {
              try {
                const response = await fetch(WHATSAPP_ENDPOINT, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ to, message }),
                });
                if (!response.ok) {
                  setWhatsappStatus("error");
                } else {
                  setWhatsappStatus("success");
                }
              } catch {
                // Falha silenciosa para não travar o fluxo principal.
                setWhatsappStatus("error");
              }
            }
          }
        };
        sendQueue();
      }
      return;
    }
  }, [
    meds,
    tick,
    notificationsEnabled,
    whatsappEnabled,
    phoneNumbers,
  ]);

  const lowStockMeds = useMemo(
    () => meds.filter((med) => med.stock <= med.lowThreshold),
    [meds]
  );

  const handleFormChange = (field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleUserChange = (field, value) => {
    setUserForm((prev) => ({ ...prev, [field]: value }));
  };

  const handlePhoneNumberChange = (index, value) => {
    setUserForm((prev) => {
      const updated = [...prev.phoneNumbers];
      updated[index] = value;
      return { ...prev, phoneNumbers: updated };
    });
  };

  const handleLogin = async (event) => {
    event.preventDefault();
    const fullName = userForm.fullName.trim();
    const password = userForm.password.trim();
    if (!fullName || !password) {
      setAuthError("Informe usuario e senha para continuar.");
      return;
    }
    const username = normalizeUsername(fullName);
    if (!username) {
      setAuthError("Informe um nome valido para login.");
      return;
    }
    const authEmail = buildAuthEmail(username);

    if (cloudEnabled) {
      setAuthLoading(true);
      try {
        const { data, error } = await supabase.auth.signInWithPassword({
          email: authEmail,
          password,
        });
        if (error) {
          setAuthError("Usuario ou senha invalidos.");
          return;
        }
        if (!data.user?.id) {
          throw new Error("Auth user not available");
        }
        setAuthError("");
        setUserForm((prev) => ({ ...prev, password: "" }));
        setShowProfileForm(false);
      } catch {
        setCloudError("Nao foi possivel autenticar o usuario.");
      } finally {
        setAuthLoading(false);
      }
      return;
    }

    setUser({ id: "local-user", fullName, email: "", phoneNumbers: ["", "", ""] });
    setAuthError("");
    setUserForm((prev) => ({ ...prev, password: "" }));
    setShowProfileForm(false);
  };

  const handleCreateUser = async () => {
    const fullName = userForm.fullName.trim();
    const password = userForm.password.trim();
    if (!fullName || !password) {
      setAuthError("Informe usuario e senha para cadastrar.");
      return;
    }
    const username = normalizeUsername(fullName);
    if (!username) {
      setAuthError("Informe um nome valido para cadastro.");
      return;
    }
    const authEmail = buildAuthEmail(username);

    if (cloudEnabled) {
      setAuthLoading(true);
      try {
        const { data: signUpData, error: signUpError } =
          await supabase.auth.signUp({
            email: authEmail,
            password,
          });
        if (signUpError) {
          setAuthError("Usuario ja existe ou senha invalida.");
          return;
        }
        const authUserId = signUpData.user?.id;
        if (!authUserId) {
          throw new Error("Auth user not available");
        }
        const trimmedUser = {
          fullName,
          email: "",
          phoneNumbers: ["", "", ""],
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        };
        const whatsappEnabledValue = true;
        const { data, error } = await supabase
          .from("profiles")
          .upsert(
            toDbUser(
              trimmedUser,
              authUserId,
              username,
              whatsappEnabledValue,
              trimmedUser.timezone
            )
          )
          .select()
          .single();
        if (error) throw error;
        setUser(fromDbUser(data));
        setAuthError("");
        setUserForm((prev) => ({ ...prev, password: "" }));
        setShowProfileForm(true);
      } catch {
        setCloudError("Nao foi possivel criar o usuario.");
      } finally {
        setAuthLoading(false);
      }
      return;
    }

    setUser({
      id: "local-user",
      fullName,
      email: "",
      phoneNumbers: ["", "", ""],
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      whatsappEnabled: true,
    });
    setAuthError("");
    setUserForm((prev) => ({ ...prev, password: "" }));
    setShowProfileForm(true);
  };

  const handleSaveUser = async (event) => {
    event.preventDefault();
    const trimmedUser = {
      fullName: userForm.fullName.trim(),
      email: userForm.email.trim(),
      phoneNumbers: userForm.phoneNumbers.map((phone) => phone.trim()),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    };
    if (!trimmedUser.fullName) {
      setAuthError("Informe o nome completo.");
      return;
    }

    if (cloudEnabled) {
      setAuthLoading(true);
      try {
        const username = user.username || normalizeUsername(trimmedUser.fullName);
        const { data, error } = await supabase
          .from("profiles")
          .update(
            toDbUser(
              trimmedUser,
              user.id,
              username,
              whatsappEnabled,
              trimmedUser.timezone
            )
          )
          .eq("id", user.id)
          .select()
          .single();
        if (error) throw error;
        setUser(fromDbUser(data));
        setCloudError("");
        setAuthError("");
        setShowProfileForm(false);
      } catch {
        setCloudError("Nao foi possivel salvar o perfil.");
      } finally {
        setAuthLoading(false);
      }
    } else {
      setUser({
        ...user,
        ...trimmedUser,
        whatsappEnabled,
        timezone: trimmedUser.timezone,
      });
      setAuthError("");
      setShowProfileForm(false);
    }

    setPhoneNumbers(trimmedUser.phoneNumbers);
  };

  const handleToggleWhatsapp = async () => {
    const nextValue = !whatsappEnabled;
    setWhatsappEnabled(nextValue);

    if (!cloudEnabled || !user.id) return;
    try {
      const username = user.username || normalizeUsername(user.fullName);
      await supabase
        .from("profiles")
        .update(
          toDbUser(
            {
              fullName: user.fullName,
              email: user.email,
              phoneNumbers,
              timezone: user.timezone || "UTC",
            },
            user.id,
            username,
            nextValue,
            user.timezone || "UTC"
          )
        )
        .eq("id", user.id);
    } catch {
      setCloudError("Não foi possível atualizar o WhatsApp.");
    }
  };

  const handleSwitchUser = () => {
    if (cloudEnabled) {
      supabase.auth.signOut();
    }
    setUser(defaultUserState);
    setUserForm(defaultUser);
    setMeds([]);
    setPhoneNumbers(["", "", ""]);
    setShowProfileForm(true);
    setAuthError("");
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(STORAGE_KEY);
  };

  const createMedInCloud = async (payload) => {
    if (!cloudEnabled || !user.id) return payload;
    const { data, error } = await supabase
      .from("meds")
      .insert(toDbMed(payload, user.id))
      .select()
      .single();
    if (error) throw error;
    return fromDbMed(data);
  };

  const updateMedInCloud = async (medId, payload) => {
    if (!cloudEnabled || !user.id) return;
    const { error } = await supabase
      .from("meds")
      .update(toDbMed({ ...payload, id: medId }, user.id))
      .eq("id", medId);
    if (error) throw error;
  };

  const deleteMedInCloud = async (medId) => {
    if (!cloudEnabled || !user.id) return;
    const { error } = await supabase.from("meds").delete().eq("id", medId);
    if (error) throw error;
  };

  const handleTimeChange = (index, value) => {
    setForm((prev) => {
      const updated = [...prev.scheduleTimes];
      updated[index] = value;
      return { ...prev, scheduleTimes: updated };
    });
  };

  const handleAddTime = () => {
    setForm((prev) => ({
      ...prev,
      scheduleTimes: [...prev.scheduleTimes, "12:00"],
    }));
  };

  const handleRemoveTime = (index) => {
    setForm((prev) => {
      const updated = prev.scheduleTimes.filter((_, idx) => idx !== index);
      return { ...prev, scheduleTimes: updated.length ? updated : ["08:00"] };
    });
  };

  const handleCreateMed = async (event) => {
    event.preventDefault();
    if (!form.name.trim()) return;

    const newMed = {
      id: crypto?.randomUUID?.() ?? `med-${Date.now()}`,
      name: form.name.trim(),
      dosage: form.dosage.trim(),
      unit: form.unit.trim() || "mg",
      doseAmount: toNumber(form.doseAmount, 1),
      stock: toNumber(form.stock, 0),
      lowThreshold: toNumber(form.lowThreshold, 0),
      scheduleTimes: form.scheduleTimes.filter(Boolean),
      alertsEnabled: form.alertsEnabled,
      autoDeduct: form.autoDeduct,
      notes: form.notes.trim(),
      lastTaken: null,
      lastAlertKey: null,
      lastAutoDoseKey: null,
      lastWhatsappAlertKey: null,
      lastLowStockWhatsappDate: null,
    };

    try {
      const savedMed = await createMedInCloud(newMed);
      setMeds((prev) => [savedMed, ...prev]);
      setForm(defaultForm);
      setCloudError("");
    } catch {
      setCloudError("Não foi possível salvar a medicação no banco compartilhado.");
    }
  };

  const handleToggleAlert = async (medId) => {
    const target = meds.find((med) => med.id === medId);
    if (!target) return;
    const nextValue = !target.alertsEnabled;
    setMeds((prev) =>
      prev.map((med) =>
        med.id === medId ? { ...med, alertsEnabled: nextValue } : med
      )
    );
    try {
      await updateMedInCloud(medId, { ...target, alertsEnabled: nextValue });
    } catch {
      setCloudError("Não foi possível atualizar os alertas no banco compartilhado.");
    }
  };

  const handleRegisterDose = async (medId) => {
    const target = meds.find((med) => med.id === medId);
    if (!target) return;
    const newStock = Math.max(0, target.stock - target.doseAmount);
    const nextTaken = new Date().toISOString();
    setMeds((prev) =>
      prev.map((med) =>
        med.id === medId ? { ...med, stock: newStock, lastTaken: nextTaken } : med
      )
    );
    try {
      await updateMedInCloud(medId, { ...target, stock: newStock, lastTaken: nextTaken });
    } catch {
      setCloudError("Não foi possível atualizar o estoque no banco compartilhado.");
    }
  };

  const handleDelete = async (medId) => {
    setMeds((prev) => prev.filter((med) => med.id !== medId));
    try {
      await deleteMedInCloud(medId);
    } catch {
      setCloudError("Não foi possível remover a medicação no banco compartilhado.");
    }
  };


  return (
    <div className="app">
      <header className="hero">
        <div>
          <div className="brand">
            <img src="/logo.png" alt="MedWatch logo" />
            <p className="eyebrow">MedWatch</p>
          </div>
          <p className="subtitle">
            {user.fullName ? `Olá, ${user.fullName}.` : "Olá!"}
          </p>
          <h1>Seu cuidado com medicação, simples e inteligente.</h1>
          <p className="subtitle">
            Cadastre, acompanhe horários e receba alertas. O foco é sempre
            lembrar quando o estoque estiver acabando.
          </p>
          {hasProfile && !showProfileForm && (
            <div className="hero-actions">
              <button
                className="btn ghost"
                type="button"
                onClick={() => setShowProfileForm(true)}
              >
                Editar perfil
              </button>
              <button className="btn ghost" type="button" onClick={handleSwitchUser}>
                Trocar usuário
              </button>
            </div>
          )}
        </div>
        {hasProfile && !showProfileForm && (
          <div className="hero-card">
            <h3>Resumo rápido</h3>
            <div className="hero-metrics">
              <div>
                <span className="metric-label">Medicações</span>
                <strong>{meds.length}</strong>
              </div>
              <div>
                <span className="metric-label">Alertas ativos</span>
                <strong>{meds.filter((med) => med.alertsEnabled).length}</strong>
              </div>
              <div>
                <span className="metric-label">Estoque baixo</span>
                <strong>{lowStockMeds.length}</strong>
              </div>
            </div>
            <div className="hero-actions">
              <button
                className="btn secondary"
                type="button"
                onClick={() => setNotificationsEnabled((prev) => !prev)}
              >
                {notificationsEnabled
                  ? "Desativar alertas do app"
                  : "Ativar alertas do app"}
              </button>
            </div>
            <div className="sms-card">
              <h4>Alertas por WhatsApp</h4>
              <div className="med-info">
                <span>
                  <strong>Telefones:</strong>{" "}
                  {phoneNumbers.filter((value) => value.trim()).length
                    ? phoneNumbers.filter((value) => value.trim()).join(", ")
                    : "Nenhum cadastrado"}
                </span>
              </div>
              <button
                className="btn secondary"
                type="button"
                onClick={handleToggleWhatsapp}
              >
                {whatsappEnabled ? "Desativar WhatsApp" : "Ativar WhatsApp"}
              </button>
              <span className="helper-text">
              {whatsappStatus === "success"
                ? "Twilio WhatsApp configurado e enviando."
                : whatsappStatus === "error"
                  ? "Falha ao enviar via Twilio. Revise as variaveis."
                  : "Requer Twilio WhatsApp configurado no Netlify."}
              </span>
            </div>
          </div>
        )}
      </header>

      {!hasProfile ? (
        <section className="grid">
          <div className="card">
            <h2>Entrar</h2>
            <form className="form" onSubmit={handleLogin}>
              <label>
                Usuario
                <input
                  type="text"
                  placeholder="Ex: Maria Silva"
                  value={userForm.fullName}
                  onChange={(event) =>
                    handleUserChange("fullName", event.target.value)
                  }
                />
              </label>
              <label>
                Senha
                <input
                  type="password"
                  placeholder="Digite sua senha"
                  value={userForm.password}
                  onChange={(event) =>
                    handleUserChange("password", event.target.value)
                  }
                />
              </label>
              {authError && <span className="helper-text">{authError}</span>}
              {cloudError && <span className="helper-text">{cloudError}</span>}
              <button className="btn primary" type="submit" disabled={authLoading}>
                {authLoading ? "Entrando..." : "Entrar"}
              </button>
              <button
                className="btn ghost"
                type="button"
                onClick={handleCreateUser}
                disabled={authLoading}
              >
                Criar novo usuario
              </button>
            </form>
          </div>
        </section>
      ) : showProfileForm ? (
        <section className="grid">
          <div className="card">
            <h2>Perfil do usuário</h2>
            <form className="form" onSubmit={handleSaveUser}>
              <label>
                Nome completo
                <input
                  type="text"
                  placeholder="Ex: Maria Silva"
                  value={userForm.fullName}
                  onChange={(event) =>
                    handleUserChange("fullName", event.target.value)
                  }
                />
              </label>
              <label>
                Email (opcional)
                <input
                  type="email"
                  placeholder="exemplo@email.com"
                  value={userForm.email}
                  onChange={(event) => handleUserChange("email", event.target.value)}
                />
              </label>
              <div className="times">
                <span>Telefones (WhatsApp)</span>
                {userForm.phoneNumbers.map((phone, index) => (
                  <div className="time-row" key={`phone-${index}`}>
                    <input
                      type="tel"
                      placeholder="+5511999999999"
                      value={phone}
                      onChange={(event) =>
                        handlePhoneNumberChange(index, event.target.value)
                      }
                    />
                  </div>
                ))}
                <span className="helper-text">
                  Adicione ate 3 numeros para receber alertas.
                </span>
              </div>
              {authError && <span className="helper-text">{authError}</span>}
              {cloudError && <span className="helper-text">{cloudError}</span>}
              <button className="btn primary" type="submit" disabled={authLoading}>
                {authLoading ? "Salvando..." : "Salvar perfil"}
              </button>
              {hasProfile && (
                <button
                  className="btn ghost"
                  type="button"
                  onClick={() => setShowProfileForm(false)}
                >
                  Voltar para medicações
                </button>
              )}
            </form>
          </div>
        </section>
      ) : (
        <>
          <section className="grid">
            <div className="card">
              <h2>Nova medicação</h2>
              <form className="form" onSubmit={handleCreateMed}>
            <label>
              Nome
              <input
                type="text"
                placeholder="Ex: Metformina"
                value={form.name}
                onChange={(event) => handleFormChange("name", event.target.value)}
                required
              />
            </label>
            <div className="row">
              <label>
                Dosagem
                <input
                  type="text"
                  placeholder="Ex: 500"
                  value={form.dosage}
                  onChange={(event) =>
                    handleFormChange("dosage", event.target.value)
                  }
                />
              </label>
              <label>
                Unidade
                <input
                  type="text"
                  placeholder="mg"
                  value={form.unit}
                  onChange={(event) => handleFormChange("unit", event.target.value)}
                />
              </label>
            </div>
            <div className="row">
              <label>
                Quantidade por dose
                <input
                  type="number"
                  min="1"
                  value={form.doseAmount}
                  onChange={(event) =>
                    handleFormChange("doseAmount", event.target.value)
                  }
                />
              </label>
              <label>
                Estoque atual
                <input
                  type="number"
                  min="0"
                  value={form.stock}
                  onChange={(event) =>
                    handleFormChange("stock", event.target.value)
                  }
                />
              </label>
              <label>
                Avisar quando restarem
                <input
                  type="number"
                  min="0"
                  value={form.lowThreshold}
                  onChange={(event) =>
                    handleFormChange("lowThreshold", event.target.value)
                  }
                />
              </label>
            </div>
            <div className="times">
              <span>Horários</span>
              {form.scheduleTimes.map((time, index) => (
                <div className="time-row" key={index}>
                  <input
                    type="time"
                    value={time}
                    onChange={(event) =>
                      handleTimeChange(index, event.target.value)
                    }
                  />
                  <button
                    className="btn ghost"
                    type="button"
                    onClick={() => handleRemoveTime(index)}
                  >
                    Remover
                  </button>
                </div>
              ))}
              <button className="btn ghost" type="button" onClick={handleAddTime}>
                + Adicionar horário
              </button>
            </div>
            <label className="toggle">
              <input
                type="checkbox"
                checked={form.alertsEnabled}
                onChange={(event) =>
                  handleFormChange("alertsEnabled", event.target.checked)
                }
              />
              Alertas ativos para esta medicação
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={form.autoDeduct}
                onChange={(event) =>
                  handleFormChange("autoDeduct", event.target.checked)
                }
              />
              Registrar dose automaticamente
            </label>
            <label>
              Observações
              <textarea
                rows="3"
                placeholder="Notas rápidas sobre o medicamento."
                value={form.notes}
                onChange={(event) => handleFormChange("notes", event.target.value)}
              />
            </label>
            <button className="btn primary" type="submit">
              Salvar medicação
            </button>
          </form>
            </div>

            <div className="card">
              <h2>Alertas e reposição</h2>
              <div className="alert-panel">
                <h3>Alertas de agora</h3>
                {notificationsEnabled && alerts.length === 0 && (
                  <p className="muted">
                    Nenhum alerta previsto nos próximos minutos.
                  </p>
                )}
                {!notificationsEnabled && (
                  <p className="muted">
                    Ative os alertas do app para ver as notificações em tempo real.
                  </p>
                )}
                {notificationsEnabled && alerts.length > 0 && (
                  <div className="alert-list">
                    {alerts.map((alert) => (
                      <div
                        className="alert-item"
                        key={`${alert.medId}-${alert.time}`}
                      >
                        <div>
                          <strong>{alert.name}</strong>
                          <span>
                            Dose: {alert.doseAmount} {alert.unit} às {alert.time}
                          </span>
                        </div>
                        <span className="badge">Agora</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="low-stock">
                <h3>Estoque baixo</h3>
                {lowStockMeds.length === 0 && (
                  <p className="muted">
                    Tudo certo por aqui. Sem reposições urgentes.
                  </p>
                )}
                {lowStockMeds.length > 0 && (
                  <div className="alert-list">
                    {lowStockMeds.map((med) => (
                      <div className="alert-item warning" key={med.id}>
                        <div>
                          <strong>{med.name}</strong>
                          <span>
                            Restam {med.stock} unidades. Repor quando possível.
                          </span>
                        </div>
                        <span className="badge warning">Repor</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </section>

          <section className="card list">
            <h2>Minhas medicações</h2>
            {cloudError && <p className="helper-text">{cloudError}</p>}
            {isLoadingMeds && (
              <p className="muted">Carregando medicações...</p>
            )}
            <div className="med-grid">
              {meds.map((med) => {
                const nextDose = getNextDose(med.scheduleTimes);
                const isLowStock = med.stock <= med.lowThreshold;
                return (
                  <article
                    className={`med-card ${isLowStock ? "danger" : ""}`}
                    key={med.id}
                  >
                    <header>
                      <div>
                        <h3>{med.name}</h3>
                        <p className="muted">
                          {med.dosage ? `${med.dosage} ${med.unit}` : med.unit}
                        </p>
                      </div>
                      <button
                        className="btn ghost"
                        onClick={() => handleDelete(med.id)}
                      >
                        Excluir
                      </button>
                    </header>
                    <div className="med-info">
                      <span>
                        <strong>Horários:</strong>{" "}
                        {med.scheduleTimes.length
                          ? med.scheduleTimes.join(", ")
                          : "—"}
                      </span>
                      <span>
                        <strong>Próxima dose:</strong>{" "}
                        {nextDose
                          ? nextDose.toLocaleTimeString("pt-BR", {
                              hour: "2-digit",
                              minute: "2-digit",
                            })
                          : "—"}
                      </span>
                      <span>
                        <strong>Estoque:</strong> {med.stock} unidades
                      </span>
                      <span>
                        <strong>Última dose:</strong>{" "}
                        {formatDateTime(med.lastTaken)}
                      </span>
                      {med.notes && <span className="notes">{med.notes}</span>}
                    </div>
                    <div className="med-actions">
                      <button
                        className="btn"
                        onClick={() => handleRegisterDose(med.id)}
                      >
                        Registrar dose
                      </button>
                      <button
                        className={`btn ${
                          med.alertsEnabled ? "secondary" : "ghost"
                        }`}
                        onClick={() => handleToggleAlert(med.id)}
                      >
                        {med.alertsEnabled
                          ? "Alertas ativos"
                          : "Alertas desativados"}
                      </button>
                      {isLowStock && <span className="pill">Estoque baixo</span>}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        </>
      )}
      <footer className="app-footer">
        v0.0.1 - Author: Mayara Gouveia
      </footer>
    </div>
  );
}
