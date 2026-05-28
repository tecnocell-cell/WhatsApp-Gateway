# WhatsApp Gateway (CenterFlow)

Gateway multi-sessão baseado em [Baileys](https://github.com/WhiskeySockets/Baileys), compatível com o contrato da Evolution API usado pelo **CenterFlow Financeiro** no fluxo de QR e conexão.

Substitui a Evolution API apenas para:

- Criar instância (`POST /instance/create`)
- Obter QR (`GET /instance/connect/:instanceName`)
- Webhooks `QRCODE_UPDATED` e `CONNECTION_UPDATE`

O Financeiro continua usando `EVOLUTION_API_URL` e `EVOLUTION_API_KEY` no `.env`, apontando para este serviço.

## Requisitos

- Node.js 18+
- npm

## Instalação

```bash
git clone https://github.com/tecnocell-cell/WhatsApp-Gateway.git
cd WhatsApp-Gateway
npm install
cp .env.example .env
# Edite .env e defina API_KEY (mesma chave do EVOLUTION_API_KEY no Financeiro)
npm start
```

Servidor padrão: `http://0.0.0.0:8081`

## Variáveis de ambiente

| Variável        | Obrigatória | Padrão              | Descrição |
|-----------------|-------------|---------------------|-----------|
| `PORT`          | Não         | `8081`              | Porta HTTP |
| `API_KEY`       | Sim         | —                   | Chave enviada no header `apikey` (igual a `EVOLUTION_API_KEY` no CenterFlow) |
| `SESSIONS_DIR`  | Não         | `./sessions`        | Pasta com uma subpasta por `instanceName` |
| `WEBHOOK_BASE_URL` | Não*     | —                   | Usada pelo Financeiro ao montar a URL do webhook (não lida pelo Gateway) |

\* O Financeiro monta a URL do webhook; o Gateway apenas repassa o `webhook.url` recebido em `/instance/create`.

Exemplo `.env`:

```env
PORT=8081
API_KEY=sua_chave_secreta_compartilhada_com_o_financeiro
SESSIONS_DIR=/opt/whatsapp-gateway/sessions
```

## Integração com CenterFlow Financeiro

No servidor do Financeiro:

```env
EVOLUTION_API_URL=http://IP_DO_GATEWAY:8081
EVOLUTION_API_KEY=<mesmo valor de API_KEY do Gateway>
WEBHOOK_BASE_URL=https://financeiro.seudominio.com
```

Todas as chamadas do Financeiro usam o header:

```http
apikey: <API_KEY>
Content-Type: application/json
```

## Endpoints

| Método | Rota | Descrição |
|--------|------|-----------|
| `GET` | `/health` | Status do serviço |
| `POST` | `/instance/create` | Cria/inicia sessão Baileys |
| `GET` | `/instance/connect/:instanceName` | Retorna QR em base64 ou estado `open` |
| `GET` | `/instance/fetchInstances` | Lista instâncias (`?instanceName=` opcional) |
| `POST` / `DELETE` | `/instance/logout/:instanceName` | Desloga WhatsApp e remove arquivos da sessão |
| `DELETE` | `/instance/delete/:instanceName` | Remove instância e pasta em disco |

Autenticação: header `apikey` (ou `api-key` / `Authorization: Bearer`).

### POST /instance/create

```json
{
  "instanceName": "cf-123",
  "integration": "WHATSAPP-BAILEYS",
  "qrcode": true,
  "webhook": {
    "url": "https://financeiro.exemplo.com/api/whatsapp/webhook/cf-123?secret=...",
    "headers": {
      "X-CenterFlow-Webhook-Secret": "..."
    },
    "events": ["QRCODE_UPDATED", "CONNECTION_UPDATE"],
    "byEvents": true
  }
}
```

### Webhooks enviados

**QRCODE_UPDATED**

```json
{
  "event": "QRCODE_UPDATED",
  "instance": "cf-123",
  "instanceName": "cf-123",
  "data": {
    "qrcode": "data:image/png;base64,...",
    "base64": "data:image/png;base64,...",
    "qrcode_base64": "data:image/png;base64,..."
  },
  "qrcode": "data:image/png;base64,...",
  "base64": "data:image/png;base64,...",
  "qrcode_base64": "data:image/png;base64,..."
}
```

**CONNECTION_UPDATE** (conectado)

```json
{
  "event": "CONNECTION_UPDATE",
  "instance": "cf-123",
  "instanceName": "cf-123",
  "data": {
    "state": "open",
    "status": "open",
    "connection": "open",
    "phone": "5511999999999@s.whatsapp.net"
  }
}
```

**CONNECTION_UPDATE** (logout / loggedOut)

```json
{
  "event": "CONNECTION_UPDATE",
  "data": {
    "state": "close",
    "status": "close",
    "connection": "close"
  }
}
```

### Comportamento de reconexão

- Desconexões **408 / timeout** e códigos transitórios: o Gateway **reinicia** a sessão Baileys sem enviar `close` definitivo ao Financeiro.
- **loggedOut** (usuário desvinculou no celular): envia `CONNECTION_UPDATE` com `state: close` e **apaga** `sessions/{instanceName}`.

## Estrutura de sessões

```
sessions/
  cf-123/
    creds.json
    ...
    webhook.json    # URL, headers e eventos persistidos
```

Não versionar `sessions/`, `.env` nem `node_modules/`.

## Deploy com systemd

1. Copie o projeto para `/opt/whatsapp-gateway`
2. `npm install --omit=dev`
3. Crie `/opt/whatsapp-gateway/.env` com `API_KEY` e `SESSIONS_DIR`
4. Ajuste e instale a unit:

```bash
sudo cp deploy/whatsapp-gateway.service.example /etc/systemd/system/whatsapp-gateway.service
sudo systemctl daemon-reload
sudo systemctl enable whatsapp-gateway
sudo systemctl start whatsapp-gateway
sudo systemctl status whatsapp-gateway
```

Logs:

```bash
journalctl -u whatsapp-gateway -f
```

## Firewall

Libere a porta `8081` (ou a definida em `PORT`) apenas para o IP do servidor CenterFlow Financeiro.

## Desenvolvimento local

```bash
npm install
npm start
curl http://localhost:8081/health
```

Teste autenticado (substitua a chave):

```bash
curl -H "apikey: SUA_API_KEY" http://localhost:8081/instance/fetchInstances
```

## Licença

ISC
