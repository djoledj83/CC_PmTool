# Reverse proxy (host nginx)

The compose stack publishes the SPA on `:3000` and the API on `:5000`. For a
real installation put nginx on the server in front of both so users open a
single address with no port, the browser talks to one origin (no CORS), and
TLS can be terminated in one place later.

```
browser ──► nginx :80 ──┬── /            ──► 127.0.0.1:3000  frontend container
                        ├── /api/        ──► 127.0.0.1:5000  backend container
                        ├── /uploads/    ──► 127.0.0.1:5000
                        └── /socket.io/  ──► 127.0.0.1:5000  (WebSocket upgrade)
```

## Install (plain HTTP)

```
sudo dnf install nginx     # RHEL/Oracle/Rocky      (Debian/Ubuntu: sudo apt install nginx)
sudo cp deploy/nginx-host.conf /etc/nginx/conf.d/pmtool.conf
sudo nginx -t && sudo systemctl enable --now nginx && sudo systemctl reload nginx
```

On Debian/Ubuntu the file goes to `/etc/nginx/sites-available/pmtool`, symlinked
into `sites-enabled`, and the stock `default` site is removed so it does not
grab port 80 first. On RHEL-family systems the stock `server` block in
`/etc/nginx/nginx.conf` must be deleted or given a different `server_name`.

Firewall (RHEL-family): `sudo firewall-cmd --permanent --add-service=http &&
sudo firewall-cmd --reload`. SELinux: `sudo setsebool -P
httpd_can_network_connect 1` so nginx may connect to the container ports.

## Point the app at the proxy

In the root `.env`:

```
APP_ORIGIN=http://<server>        # what users type — no port
API_URL=http://<server>           # same origin; nginx routes /api, /uploads, /socket.io
BIND_ADDRESS=127.0.0.1            # containers listen on localhost only, nginx is the only way in
```

`API_URL` is baked into the frontend at build time, so rebuild:

```
docker compose up -d --build
```

Check: `curl -s http://<server>/api/ready` returns the readiness JSON and
`http://<server>/` shows the login page.

## Adding HTTPS later

1. Obtain a certificate for the DNS name (company CA or Let's Encrypt).
2. In `pmtool.conf` add a `server { listen 443 ssl; ssl_certificate …;
   ssl_certificate_key …; }` block with the same `location`s, and turn the
   port-80 block into `return 301 https://$host$request_uri;`.
3. Root `.env`: `APP_ORIGIN=https://…`, `API_URL=https://…`,
   `COOKIE_SECURE=true`; rebuild the frontend.
4. Optionally tighten the frontend container's CSP in `frontend/nginx.conf`
   (`connect-src`) to the explicit https/wss origin.
