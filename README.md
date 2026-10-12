# Bsmtp Email Studio backend

This folder is an independent Node.js 18+ API. It does not serve or contain the frontend.

## Start locally

Create `backend/.env` with these variables:

```env
ALLOWED_ORIGINS=http://127.0.0.1:5500
BREVO_API_KEY=your_new_brevo_api_key
```

Start the backend from this folder with `npm start`. The backend reads `backend/.env` on startup; variables already set in the process environment take precedence over values in `.env`. The `.env` file is ignored by Git. Restart the backend after changing environment variables.

Serve the separate `frontend/` folder on the allowed local origin, then enter the backend URL in the frontend's **API settings**. For another local static-server port, update `ALLOWED_ORIGINS` to that exact origin.

The local backend does not require an access token. Keep it bound to localhost; do not expose it to the public internet because API settings and email sending are unauthenticated.

## Deploy separately

Deploy this folder as a Node.js service with Node.js 18 or newer and set:

- `BREVO_API_KEY`: your Brevo API key. For the built-in Bsmtp provider, this value is read by the backend and is never returned to the frontend. It is required to send email.
- `ALLOWED_ORIGINS`: comma-separated exact HTTPS origins allowed to use the API, such as `https://your-name.github.io`.
- `HOST`: optional. Render is detected automatically and binds to `0.0.0.0`; set this to `0.0.0.0` on other hosting platforms that require listening on the public interface.
- `PORT`: set by most hosting platforms automatically.
- `APP_CONFIG_FILE` (optional): a file path on persistent storage for provider settings. Without it, settings use the host's app-data directory.

Do not deploy this backend publicly as-is: it has no authentication, so anyone who can reach it can change provider settings or send email. Use it only on localhost or behind a trusted network.

## Provider configuration

The built-in Brevo provider reads `BREVO_API_KEY` from the backend environment or `backend/.env`; the key is not entered in the frontend and is never returned by the API. Custom provider keys are entered in the frontend and stored by the backend outside its source tree. A custom provider can be set up with a public HTTPS endpoint, auth header/prefix, and JSON request template. The backend blocks redirects and endpoints that resolve to private IP addresses.

The frontend can send separate messages to up to 100 unique recipients from one compose action. It makes individual `/api/send` requests sequentially with a five-second gap between sends, so each provider response is independently reflected in the delivery queue.