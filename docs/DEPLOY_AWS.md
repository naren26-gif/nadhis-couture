# Deploy on AWS EC2 with Docker

Result: the app at `https://app.<your-domain>`, with a free automatic HTTPS certificate, running in two Docker containers
(the app, and Caddy in front of it) on one small EC2 server. The database stays on Supabase.
Never paste passwords or connection strings into chat, screenshots or files in this repository.

## 0. Try it on your PC first (against DEV)
```powershell
# one-time: a copy of .env WITHOUT any admin line (the app never needs the admin login)
Get-Content .env | Where-Object { $_ -notmatch 'ADMIN' } | Set-Content .env.docker

$env:NADHI_ENV_FILE = '.env.docker'
$env:APP_DOMAIN     = 'http://localhost'
docker compose up -d --build
docker compose ps                      # app should say (healthy)
# open http://localhost  and  http://localhost/api/health
docker compose down                    # stop when done
```
`.env.docker` is git-ignored. Port 80 must be free on your PC.

## 1. AWS account basics (5 minutes, once)
- Sign in as an IAM user or Identity Center user, not the root user. Turn on MFA for root and for yourself.
- Billing > Budgets: create a monthly budget alert (for example 1,500 INR) so a surprise cannot grow.
- Region: **Asia Pacific (Mumbai) ap-south-1** (same area as the database, so it is fast).

## 2. Buy a domain and decide the address
Buy any domain (Route 53 > Registered domains, or any registrar). The app will live at `app.<your-domain>`.

### No domain yet? Use a free name that points at your IP
Do NOT run the app over plain `http://<ip>`: the login cookie is HTTPS-only in production (so login would fail) and your
password would travel unencrypted. Instead use a free hostname that resolves to your Elastic IP, and Caddy gets a real
certificate for it. Write the IP with dashes: for IP `13.233.10.20` the address is `13-233-10-20.sslip.io`.
Set `APP_DOMAIN=13-233-10-20.sslip.io` in `/etc/nadhi/env` and skip step 4 (no DNS record needed). If the certificate is
refused (that free service is shared and can hit limits), use a free DuckDNS name instead (duckdns.org, pick a name, point
it at the IP, use `yourname.duckdns.org` as `APP_DOMAIN`). When you buy a domain later, change `APP_DOMAIN`, add the A
record, and run `./deploy/deploy.sh` again.

## 3. Launch the server (EC2 > Launch instance)
| Setting | Value |
|---|---|
| Name / tags | `nadhis-couture`, tag `project = nadhis-couture` |
| Image | Ubuntu Server 24.04 LTS |
| Type | `t3.small` (or `t4g.small`, ARM, a little cheaper; both work) |
| Key pair | Create new, download the `.pem` file, keep it safe (it is your SSH password) |
| Network / security group | New group: **SSH (22) from "My IP" only**, **HTTP (80)** and **HTTPS (443)** from anywhere |
| Storage | 20 GB gp3 |

Then EC2 > **Elastic IPs** > Allocate > Associate with this instance (so the address never changes).
Do NOT open any other port. The database is reached outward; the app container is not reachable from outside.

## 4. Point the domain at the server
In your DNS (Route 53 hosted zone or registrar): add an **A record** `app` pointing to the Elastic IP. Wait a few minutes.
Check: `nslookup app.<your-domain>` shows your Elastic IP.

## 5. Set up the server (SSH in)
```powershell
ssh -i C:\path\to\your-key.pem ubuntu@<elastic-ip>
```
On the server:
```bash
# automatic security updates
sudo apt-get update && sudo apt-get install -y unattended-upgrades git ca-certificates curl

# Docker (official repository)
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# the code (public repository)
git clone https://github.com/naren26-gif/nadhis-couture.git
cd nadhis-couture
```

## 6. The production settings file (secrets stay ONLY here)
```bash
sudo mkdir -p /etc/nadhi
sudo cp deploy/env.example /etc/nadhi/env
sudo nano /etc/nadhi/env          # fill in every <placeholder>
sudo chown root:root /etc/nadhi/env && sudo chmod 600 /etc/nadhi/env
```
- `APP_DOMAIN`: `app.<your-domain>`
- `APP_DB_URL`: the PRODUCTION `app_backend` login (user `app_backend.<project-ref>`, Session pooler host)
- `SESSION_SECRET`: a NEW random value: `openssl rand -hex 32`
- `NODE_ENV=production`
- Do not put the admin (`postgres`) string here, ever.
- `certs/supabase-ca.crt` in the repository must be the certificate of the PRODUCTION project (Supabase > Project Settings >
  Database > SSL Configuration > Download). Compare it with the repository file; if different, replace the file, commit and
  `git pull` on the server.

## 7. Start it
```bash
./deploy/deploy.sh
```
First build takes a few minutes. Then open `https://app.<your-domain>/api/health`: you should see `{"ok":true,"db":true}`
and a valid certificate (padlock). `http://` should redirect to `https://`.
If the certificate does not appear: check the DNS record and that ports 80/443 are open in the security group, then
`sudo docker compose --env-file /etc/nadhi/env logs caddy`.

## 8. Create the production login (the password is typed at a hidden prompt, on the server)
```bash
sudo docker compose --env-file /etc/nadhi/env run --rm app node server/scripts/create-user.js
```

## 9. Check it on your phone (mobile data, not Wi-Fi)
Log in at `https://app.<your-domain>`. Look at Home, Inventory and Reports; the numbers should equal what
`db/verify_production.sql` showed (stock 51, 4 orders, courier owed 250.00). Do not enter test data in production.

## Updating later
```bash
ssh ... ; cd nadhis-couture ; ./deploy/deploy.sh
```
Logs: `sudo docker compose --env-file /etc/nadhi/env logs -f app`. Restart: `... restart app`.
Take a database backup (`scripts/backup.ps1`) before any update that includes a database migration.

## Moving to a business AWS account later
Nothing here is tied to your personal account: repeat sections 1, 3-8 in the new account, copy `/etc/nadhi/env`, move the DNS
A record to the new Elastic IP, then terminate the old instance. The database does not move.
