import twilio from "twilio";

const jsonResponse = (statusCode, payload) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify(payload),
});

export const handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_WHATSAPP_FROM;

  if (!accountSid || !authToken || !fromNumber) {
    return jsonResponse(500, { error: "Twilio WhatsApp não configurado." });
  }

  let payload = {};
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse(400, { error: "Payload inválido." });
  }

  const { to, message } = payload;
  if (!to || !message) {
    return jsonResponse(400, { error: "Campos 'to' e 'message' são obrigatórios." });
  }

  try {
    const client = twilio(accountSid, authToken);
    const toNumber = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;
    const fromValue = fromNumber.startsWith("whatsapp:")
      ? fromNumber
      : `whatsapp:${fromNumber}`;

    const result = await client.messages.create({
      body: message,
      from: fromValue,
      to: toNumber,
    });

    return jsonResponse(200, { sid: result.sid });
  } catch (error) {
    return jsonResponse(500, { error: "Falha ao enviar WhatsApp." });
  }
};
