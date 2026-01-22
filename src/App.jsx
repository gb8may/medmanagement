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
  notes: "",
};

const defaultUser = {
  fullName: "",
  email: "",
  phone: "",
};

const defaultUserState = {
  id: "",
  fullName: "",
  email: "",
  phone: "",
};

const toDbUser = (user) => ({
  full_name: user.fullName,
  email: user.email,
  phone: user.phone,
});

const fromDbUser = (row) => ({
  id: row.id,
  fullName: row.full_name ?? "",
  email: row.email ?? "",
  phone: row.phone ?? "",
});

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
  notes: med.notes,
  last_taken: med.lastTaken,
  last_alert_key: med.lastAlertKey,
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
  notes: row.notes ?? "",
  lastTaken: row.last_taken ?? null,
  lastAlertKey: row.last_alert_key ?? null,
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
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [whatsappEnabled, setWhatsappEnabled] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState("");
  const [notificationStatus, setNotificationStatus] = useState(
    typeof Notification === "undefined" ? "unsupported" : Notification.permission
  );
  const [isLoadingMeds, setIsLoadingMeds] = useState(false);
  const [cloudError, setCloudError] = useState("");

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
        setPhoneNumber(parsed.phoneNumber || "");
      } catch {
        setNotificationsEnabled(false);
        setWhatsappEnabled(false);
        setPhoneNumber("");
      }
    }

    const savedUser = localStorage.getItem(USER_KEY);
    if (savedUser) {
      try {
        const parsed = JSON.parse(savedUser);
        setUser(parsed);
        setUserForm({
          fullName: parsed.fullName || "",
          email: parsed.email || "",
          phone: parsed.phone || "",
        });
        setShowProfileForm(!parsed.id);
      } catch {
        setUser(defaultUserState);
        setUserForm(defaultUser);
      }
    }
  }, [cloudEnabled]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(meds));
  }, [meds]);

  useEffect(() => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ notificationsEnabled, whatsappEnabled, phoneNumber })
    );
  }, [notificationsEnabled, whatsappEnabled, phoneNumber]);

  useEffect(() => {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  }, [user]);

  useEffect(() => {
    const loadUserFromCloud = async () => {
      if (!cloudEnabled || !user.id) return;
      try {
        const { data, error } = await supabase
          .from("users")
          .select("*")
          .eq("id", user.id)
          .single();

        if (error) throw error;
        const updatedUser = fromDbUser(data);
        setUser(updatedUser);
        setUserForm({
          fullName: updatedUser.fullName,
          email: updatedUser.email,
          phone: updatedUser.phone,
        });
        if (!phoneNumber && updatedUser.phone) {
          setPhoneNumber(updatedUser.phone);
        }
      } catch {
        setCloudError("Não foi possível carregar o perfil compartilhado.");
      }
    };

    loadUserFromCloud();
  }, [cloudEnabled, user.id, phoneNumber]);

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

    if (
      notificationsEnabled &&
      notificationStatus === "granted" &&
      dueAlerts.length
    ) {
      dueAlerts.forEach((alert) => {
        new Notification(`Hora de tomar ${alert.name}`, {
          body: `Dose: ${alert.doseAmount} ${alert.unit} às ${alert.time}.`,
        });
      });
    }

    if (whatsappEnabled && phoneNumber) {
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
            try {
              await fetch(WHATSAPP_ENDPOINT, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ to: phoneNumber, message }),
              });
            } catch {
              // Falha silenciosa para não travar o fluxo principal.
            }
          }
        };
        sendQueue();
      }
      return;
    }

    if (updatedMeds) {
      setMeds(updatedMeds);
    }
  }, [
    meds,
    tick,
    notificationsEnabled,
    notificationStatus,
    whatsappEnabled,
    phoneNumber,
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

  const handleSaveUser = async (event) => {
    event.preventDefault();
    const trimmedUser = {
      fullName: userForm.fullName.trim(),
      email: userForm.email.trim(),
      phone: userForm.phone.trim(),
    };

    if (cloudEnabled) {
      try {
        if (user.id) {
          const { data, error } = await supabase
            .from("users")
            .update(toDbUser(trimmedUser))
            .eq("id", user.id)
            .select()
            .single();
          if (error) throw error;
          setUser(fromDbUser(data));
        } else {
          const { data, error } = await supabase
            .from("users")
            .insert(toDbUser(trimmedUser))
            .select()
            .single();
          if (error) throw error;
          setUser(fromDbUser(data));
        }
        setCloudError("");
        setShowProfileForm(false);
      } catch {
        setCloudError("Não foi possível salvar o perfil no banco compartilhado.");
      }
    } else {
      setUser({ id: user.id || "local-user", ...trimmedUser });
      setShowProfileForm(false);
    }

    if (!phoneNumber && trimmedUser.phone) {
      setPhoneNumber(trimmedUser.phone);
    }
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
      notes: form.notes.trim(),
      lastTaken: null,
      lastAlertKey: null,
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

  const requestNotifications = async () => {
    if (typeof Notification === "undefined") {
      setNotificationStatus("unsupported");
      return;
    }

    const permission = await Notification.requestPermission();
    setNotificationStatus(permission);
    if (permission === "granted") {
      setNotificationsEnabled(true);
    }
  };

  return (
    <div className="app">
      <header className="hero">
        <div>
          <p className="eyebrow">MedWatch</p>
          <p className="subtitle">
            {user.fullName ? `Olá, ${user.fullName}.` : "Olá!"}
          </p>
          <h1>Seu cuidado com medicação, simples e inteligente.</h1>
          <p className="subtitle">
            Cadastre, acompanhe horários e receba alertas. O foco é sempre
            lembrar quando o estoque estiver acabando.
          </p>
          {hasProfile && !showProfileForm && (
            <button
              className="btn ghost"
              type="button"
              onClick={() => setShowProfileForm(true)}
            >
              Editar perfil
            </button>
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
              <button className="btn" type="button" onClick={requestNotifications}>
                {notificationStatus === "granted"
                  ? "Alertas do navegador ativos"
                  : "Ativar alertas do navegador"}
              </button>
              {notificationStatus === "denied" && (
                <span className="helper-text">
                  Permissão do navegador negada. Libere nas configurações do site.
                </span>
              )}
            </div>
            <div className="sms-card">
              <h4>Alertas por WhatsApp</h4>
              <label>
                Telefone (com DDI)
                <input
                  type="tel"
                  placeholder="+5511999999999"
                  value={phoneNumber}
                  onChange={(event) => setPhoneNumber(event.target.value)}
                />
              </label>
              <button
                className="btn secondary"
                type="button"
                onClick={() => setWhatsappEnabled((prev) => !prev)}
              >
                {whatsappEnabled ? "Desativar WhatsApp" : "Ativar WhatsApp"}
              </button>
              <span className="helper-text">
                Requer WhatsApp Cloud API configurada no Netlify.
              </span>
            </div>
          </div>
        )}
      </header>

      {!hasProfile || showProfileForm ? (
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
                Email
                <input
                  type="email"
                  placeholder="exemplo@email.com"
                  value={userForm.email}
                  onChange={(event) => handleUserChange("email", event.target.value)}
                />
              </label>
              <label>
                Telefone (WhatsApp)
                <input
                  type="tel"
                  placeholder="+5511999999999"
                  value={userForm.phone}
                  onChange={(event) => handleUserChange("phone", event.target.value)}
                />
              </label>
              {cloudError && <span className="helper-text">{cloudError}</span>}
              <button className="btn primary" type="submit">
                Salvar perfil
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
                <div className="time-row" key={`${time}-${index}`}>
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
