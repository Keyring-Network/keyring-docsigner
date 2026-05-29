# Local Development Guide

## Prerequisites

- Docker Desktop (or Docker Engine + Compose plugin)
- Node.js 18, 20, or 22 (only needed if running frontend Vite dev server directly)

---

## Quick start (fully Dockerised)

```bash
docker-compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

Both images are built from source the first time; subsequent starts that do not
involve source changes can drop `--build`.

| Service      | URL                        | Notes                                      |
|--------------|----------------------------|--------------------------------------------|
| Frontend     | http://localhost:3000      | Served by `server.cjs` (static SPA build)  |
| Parse Server | http://localhost:8080/app  | Direct API access, bypasses Caddy          |
| MongoDB      | localhost:27018             | Exposed for GUI clients (e.g. Compass)     |
| Caddy proxy  | http://localhost:80        | Proxies `/api/*` → server, rest → client   |

> Caddy also listens on port 3001 and 443. For pure local dev the Caddy layer
> is optional – the app works fine when accessed directly on port 3000.

---

## Environment configuration

The file `.env.prod` is read by both the `server` and `client` Compose services
(via `env_file: .env.prod` in `docker-compose.yml`).

Key settings already configured for local dev:

| Variable             | Value                                    | Purpose                                  |
|----------------------|------------------------------------------|------------------------------------------|
| `MONGODB_URI`        | `mongodb://mongo-container:27017/OpenSignDB` | Points to the Compose MongoDB service |
| `SERVER_URL`         | `http://server:8080/app`                 | Internal container-to-container URL      |
| `REACT_APP_SERVERURL`| `http://localhost:8080/app`              | Browser-facing API URL                   |
| `USE_LOCAL`          | `true`                                   | Files stored on disk, no S3 needed       |
| `SMTP_ENABLE`        | `false`                                  | Email sending disabled                   |

---

## First-time setup: creating an admin account

1. Open http://localhost:3000 in your browser.
2. Click **Sign Up** and register with any email address and password.
   The server runs with `verifyUserEmails: false`, so no email confirmation
   is needed.
3. The first registered user is a regular user. To promote them to admin via
   the Parse master key, use the Parse REST API or a Parse Dashboard instance:

   ```bash
   # Fetch the user's objectId
   curl -X GET \
     -H "X-Parse-Application-Id: opensign" \
     -H "X-Parse-Master-Key: XnAadwKxxByMr" \
     http://localhost:8080/app/users

   # Set the isAdmin flag (replace <objectId> with the real value)
   curl -X PUT \
     -H "X-Parse-Application-Id: opensign" \
     -H "X-Parse-Master-Key: XnAadwKxxByMr" \
     -H "Content-Type: application/json" \
     -d '{"isAdmin": true}' \
     http://localhost:8080/app/users/<objectId>
   ```

---

## Iterating on backend code

The `docker-compose.dev.yml` override mounts several server source directories
directly into the running container:

- `apps/OpenSignServer/cloud/`
- `apps/OpenSignServer/utils/`
- `apps/OpenSignServer/auth/`
- `apps/OpenSignServer/migrationdb/`
- `apps/OpenSignServer/Utils.js`
- `apps/OpenSignServer/index.js`

After editing these files, restart just the server container to pick up changes:

```bash
docker-compose -f docker-compose.yml -f docker-compose.dev.yml restart server
```

For a watch loop without manual restarts, override the server's command to use
`nodemon` (already a dev dependency):

```bash
docker-compose -f docker-compose.yml -f docker-compose.dev.yml \
  run --rm --service-ports server \
  npx nodemon index.js
```

---

## Iterating on frontend code (fast path)

The client container performs a full Vite build at image-build time. Rebuilding
the image for every frontend change is slow. Instead, run Vite's dev server
directly on the host while keeping the backend stack running in Docker:

```bash
# Terminal 1 – start backend stack only
docker-compose -f docker-compose.yml -f docker-compose.dev.yml up server mongo

# Terminal 2 – run Vite dev server on the host
cd apps/OpenSign
npm install
npm run dev   # starts on http://localhost:3000 with HMR
```

The Vite config reads `REACT_APP_SERVERURL` from a `.env` file in
`apps/OpenSign/`. Create one (or symlink from the root):

```bash
echo "REACT_APP_SERVERURL=http://localhost:8080/app" > apps/OpenSign/.env.local
echo "REACT_APP_APPID=opensign" >> apps/OpenSign/.env.local
```

---

## Dockerfiles

Neither `apps/OpenSign` nor `apps/OpenSignServer` contain a file literally
named `Dockerfile`. Both apps use `Dockerhubfile` instead (the upstream project
convention for files published to Docker Hub). The `docker-compose.dev.yml`
override references these files explicitly via `dockerfile: apps/*/Dockerhubfile`.

| App            | Base image       | Notable build steps                                               |
|----------------|------------------|-------------------------------------------------------------------|
| OpenSign       | `node:22.14.0`   | `npm install` → `vite build` → injects `env.js` into `index.html` → serves via `server.cjs` on port 3000 |
| OpenSignServer | `node:22.14.0`   | Installs LibreOffice (DOCX→PDF), `npm install` → `node index.js` on port 8080 |

The OpenSignServer image install of LibreOffice makes the first build
**significantly slower** (several minutes). Subsequent builds reuse the Docker
layer cache as long as `package*.json` files are unchanged.

---

## Known gotchas

1. **`REACT_APP_SERVERURL` is baked in at build time.**  The entrypoint script
   (`entrypoint.sh`) regenerates `build/env.js` at container start using the
   value from `.env.prod`, so the variable *is* runtime-injectable for the
   Docker build. However, if you run Vite dev server on the host, Vite bakes
   the value from `.env.local` at startup – restart `npm run dev` after
   changing it.

2. **`SERVER_URL` vs `REACT_APP_SERVERURL`.**  These serve different audiences:
   - `REACT_APP_SERVERURL` – used by the browser to reach the API
     (`http://localhost:8080/app`).
   - `SERVER_URL` – used by server-side cloud functions to call back into
     Parse (`http://server:8080/app`, i.e. the internal Docker network name).
   Setting both to `localhost:8080` causes cloud functions to fail inside
   Docker because `localhost` inside a container refers to the container itself.

3. **MongoDB port clash.**  The Compose file maps Mongo to host port `27018`
   (not the default `27017`) to avoid conflicting with any locally-running
   MongoDB instance.

4. **LibreOffice inside OpenSignServer.**  The `apt-get install libreoffice`
   step runs during image build and downloads ~300 MB. Keep Docker layer cache
   warm by avoiding changes to `apps/OpenSignServer/package*.json` unless
   necessary.

5. **Caddy TLS.**  The default `docker-compose.yml` starts Caddy which tries to
   serve on port 443. For pure local dev you can skip Caddy entirely:

   ```bash
   docker-compose -f docker-compose.yml -f docker-compose.dev.yml \
     up --build server mongo client
   ```

6. **Email features.**  With `SMTP_ENABLE=false` and no Mailgun key, features
   that send email (password reset, signing invitations) will silently fail to
   deliver. Use the direct signing link from the Parse database for testing, or
   configure a local SMTP sink such as [Mailpit](https://github.com/axllent/mailpit).
