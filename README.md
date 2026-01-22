# MedWatch

## Deploy no Netlify

Este projeto já inclui `netlify.toml` com o build e publish corretos.

1. No Netlify, importe o repositório.
2. Build command: `npm run build`
3. Publish directory: `dist`
4. Faça o deploy.

## Alertas por WhatsApp (Twilio)

O envio de mensagens usa uma Function do Netlify (`/.netlify/functions/send-whatsapp`).
Configure as variáveis de ambiente no painel do Netlify (Twilio):

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_WHATSAPP_FROM` (ex: `whatsapp:+14155238886`)

No app, informe seu telefone com DDI (ex: `+5511999999999`) e ative o WhatsApp.

## Alertas em background (Supabase Edge Function)

Para enviar alertas mesmo com o navegador fechado, use a Edge Function do Supabase.

### Variáveis de ambiente (Supabase)

- `SERVICE_ROLE_KEY`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_WHATSAPP_FROM` (ex: `whatsapp:+14155238886`)

### Deploy da Function

```
supabase functions deploy send-alerts
```

Depois, no painel do Supabase, crie um **Scheduled Function** para rodar
`send-alerts` a cada minuto.

### Ajustes no banco (Supabase)

```sql
alter table public.profiles
  add column if not exists phone_numbers text[],
  add column if not exists whatsapp_enabled boolean default true,
  add column if not exists timezone text default 'UTC';

alter table public.meds
  add column if not exists auto_deduct boolean default false,
  add column if not exists last_auto_dose_key text;
```

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