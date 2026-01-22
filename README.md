# MedWatch

## Deploy no Netlify

Este projeto já inclui `netlify.toml` com o build e publish corretos.

1. No Netlify, importe o repositório.
2. Build command: `npm run build`
3. Publish directory: `dist`
4. Faça o deploy.

## Alertas por WhatsApp (Cloud API)

O envio de mensagens usa uma Function do Netlify (`/.netlify/functions/send-whatsapp`).
Configure as variáveis de ambiente no painel do Netlify (WhatsApp Cloud API):

- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`

No app, informe seu telefone com DDI (ex: `+5511999999999`) e ative o WhatsApp.

### Desenvolvimento local

Para testar WhatsApp localmente, use o Netlify CLI:

```
netlify dev
```

### Badge opcional

Substitua `SEU_SITE` pelo slug do seu site no Netlify:

```
[![Netlify Status](https://api.netlify.com/api/v1/badges/SEU_SITE/deploy-status)](https://app.netlify.com/sites/SEU_SITE/deploys)
```