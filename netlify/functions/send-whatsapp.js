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

  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!accessToken || !phoneNumberId) {
    return jsonResponse(500, { error: "WhatsApp não configurado." });
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
    const response = await fetch(
      `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { body: message },
        }),
      }
    );

    if (!response.ok) {
      return jsonResponse(500, { error: "Falha ao enviar WhatsApp." });
    }

    const data = await response.json();
    return jsonResponse(200, { result: data });
  } catch (error) {
    return jsonResponse(500, { error: "Falha ao enviar WhatsApp." });
  }
};
