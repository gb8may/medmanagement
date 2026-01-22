import { useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "medmanager:meds";
const SETTINGS_KEY = "medmanager:settings";
const ALERT_WINDOW_MINUTES = 10;
const WHATSAPP_ENDPOINT = "/.netlify/functions/send-whatsapp";

const sampleMeds = [
  {
    id: "med-1",
    name: "Vitamina D",
    dosage: "2.000",
    unit: "UI",
    doseAmount: 1,
    stock: 18,
    lowThreshold: 7,
    scheduleTimes: ["08:00"],
    alertsEnabled: true,
    notes: "Tomar após o café da manhã.",
    lastTaken: null,
    lastAlertKey: null,
    lastWhatsappAlertKey: null,
    lastLowStockWhatsappDate: null,
  },
  {
    id: "med-2",
    name: "Losartana",
    dosage: "50",
    unit: "mg",
    doseAmount: 1,
    stock: 6,
    lowThreshold: 10,
    scheduleTimes: ["08:00", "20:00"],
    alertsEnabled: true,
    notes: "Monitorar pressão arterial.",
    lastTaken: null,
    lastAlertKey: null,
    lastWhatsappAlertKey: null,
    lastLowStockWhatsappDate: null,
  },
];

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
  const [alerts, setAlerts] = useState([]);
  const [tick, setTick] = useState(Date.now());
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [whatsappEnabled, setWhatsappEnabled] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState("");
  const [notificationStatus, setNotificationStatus] = useState(
    typeof Notification === "undefined" ? "unsupported" : Notification.permission
  );

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    const settings = localStorage.getItem(SETTINGS_KEY);

    if (saved) {
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
  }, []);

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

  const handleCreateMed = (event) => {
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

    setMeds((prev) => [newMed, ...prev]);
    setForm(defaultForm);
  };

  const handleToggleAlert = (medId) => {
    setMeds((prev) =>
      prev.map((med) =>
        med.id === medId ? { ...med, alertsEnabled: !med.alertsEnabled } : med
      )
    );
  };

  const handleRegisterDose = (medId) => {
    setMeds((prev) =>
      prev.map((med) => {
        if (med.id !== medId) return med;
        const newStock = Math.max(0, med.stock - med.doseAmount);
        return { ...med, stock: newStock, lastTaken: new Date().toISOString() };
      })
    );
  };

  const handleDelete = (medId) => {
    setMeds((prev) => prev.filter((med) => med.id !== medId));
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
          <p className="eyebrow">MedManager</p>
          <h1>Seu cuidado com medicação, simples e inteligente.</h1>
          <p className="subtitle">
            Cadastre, acompanhe horários e receba alertas. O foco é sempre
            lembrar quando o estoque estiver acabando.
          </p>
        </div>
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
              {notificationsEnabled ? "Desativar alertas do app" : "Ativar alertas do app"}
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
      </header>

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
              <p className="muted">Nenhum alerta previsto nos próximos minutos.</p>
            )}
            {!notificationsEnabled && (
              <p className="muted">
                Ative os alertas do app para ver as notificações em tempo real.
              </p>
            )}
            {notificationsEnabled && alerts.length > 0 && (
              <div className="alert-list">
                {alerts.map((alert) => (
                  <div className="alert-item" key={`${alert.medId}-${alert.time}`}>
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
              <p className="muted">Tudo certo por aqui. Sem reposições urgentes.</p>
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
        <div className="med-grid">
          {meds.map((med) => {
            const nextDose = getNextDose(med.scheduleTimes);
            const isLowStock = med.stock <= med.lowThreshold;
            return (
              <article className={`med-card ${isLowStock ? "danger" : ""}`} key={med.id}>
                <header>
                  <div>
                    <h3>{med.name}</h3>
                    <p className="muted">
                      {med.dosage ? `${med.dosage} ${med.unit}` : med.unit}
                    </p>
                  </div>
                  <button className="btn ghost" onClick={() => handleDelete(med.id)}>
                    Excluir
                  </button>
                </header>
                <div className="med-info">
                  <span>
                    <strong>Horários:</strong>{" "}
                    {med.scheduleTimes.length ? med.scheduleTimes.join(", ") : "—"}
                  </span>
                  <span>
                    <strong>Próxima dose:</strong>{" "}
                    {nextDose ? nextDose.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "—"}
                  </span>
                  <span>
                    <strong>Estoque:</strong> {med.stock} unidades
                  </span>
                  <span>
                    <strong>Última dose:</strong> {formatDateTime(med.lastTaken)}
                  </span>
                  {med.notes && <span className="notes">{med.notes}</span>}
                </div>
                <div className="med-actions">
                  <button className="btn" onClick={() => handleRegisterDose(med.id)}>
                    Registrar dose
                  </button>
                  <button
                    className={`btn ${med.alertsEnabled ? "secondary" : "ghost"}`}
                    onClick={() => handleToggleAlert(med.id)}
                  >
                    {med.alertsEnabled ? "Alertas ativos" : "Alertas desativados"}
                  </button>
                  {isLowStock && <span className="pill">Estoque baixo</span>}
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
