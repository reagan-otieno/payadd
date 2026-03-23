# AdPay — Deployment Guide
## Node.js + PostgreSQL Backend

---

## FOLDER STRUCTURE

```
adpay/                  ← Your frontend files (deploy these)
  index.html
  admin.html
  app.js
  api.js                ← Talks to the backend
  style.css
  manifest.json
  sw.js

adpay-server/           ← Your backend (deploy this separately)
  server.js             ← Main Express server
  db.js                 ← PostgreSQL connection
  schema.sql            ← Database setup
  routes/
    auth.js             ← Register, login, /me
    ads.js              ← List ads, watch ads
    wallet.js           ← Deposit, withdraw, transactions
    admin.js            ← All admin endpoints
    misc.js             ← Notifications, leaderboard
  middleware/
    auth.js             ← JWT verification
  .env.example          ← Copy to .env and fill in
  package.json
```

---

## LOCAL SETUP (development)

### 1. Install PostgreSQL
- Mac:    `brew install postgresql && brew services start postgresql`
- Ubuntu: `sudo apt install postgresql && sudo systemctl start postgresql`
- Windows: Download from https://postgresql.org/download/windows/

### 2. Create database and user
```bash
psql -U postgres
CREATE USER adpay_user WITH PASSWORD 'your_strong_password';
CREATE DATABASE adpay OWNER adpay_user;
GRANT ALL PRIVILEGES ON DATABASE adpay TO adpay_user;
\q
```

### 3. Set up environment
```bash
cd adpay-server
cp .env.example .env
# Edit .env with your actual values
nano .env
```

### 4. Run database schema
```bash
psql -U adpay_user -d adpay -f schema.sql
# You should see: INSERT 0 10 (ads seeded)
```

### 5. Install dependencies and start
```bash
npm install
npm start
# Server runs on http://localhost:3000
```

### 6. Open your site
- Frontend: http://localhost:3000
- Admin:    http://localhost:3000/admin.html?key=ADPAY_ADMIN_2025

---

## PRODUCTION DEPLOYMENT

### Option A — Railway.app (Recommended, free tier available)

1. Go to https://railway.app and sign up
2. New Project → Deploy from GitHub (push your adpay-server folder)
3. Add a PostgreSQL database: New → Database → PostgreSQL
4. In your service settings, add Environment Variables from .env
5. Set `DATABASE_URL` to Railway's auto-provided PostgreSQL URL
6. Deploy — Railway gives you a URL like `https://adpay-server.up.railway.app`

Then in your frontend `api.js`, change:
```js
const API_BASE = window.location.hostname === 'localhost'
  ? 'http://localhost:3000/api'
  : 'https://YOUR-RAILWAY-URL.up.railway.app/api';
```

### Option B — Render.com (free tier)

1. Go to https://render.com
2. New → Web Service → connect your GitHub repo
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Add a Render PostgreSQL database
6. Set environment variables in the Render dashboard
7. Run schema: use Render's PostgreSQL shell → paste schema.sql

### Option C — VPS (DigitalOcean, Linode, Hetzner)

```bash
# On your VPS
git clone <your-repo>
cd adpay-server
npm install
cp .env.example .env && nano .env

# Install PostgreSQL
sudo apt install postgresql
sudo -u postgres createdb adpay
psql -d adpay -f schema.sql

# Run with PM2 (keeps server alive)
npm install -g pm2
pm2 start server.js --name adpay
pm2 save && pm2 startup

# Nginx reverse proxy (recommended)
# Point your domain to the VPS and configure nginx to proxy to port 3000
```

### Serving Frontend

Option 1: Let Node serve it (already configured in server.js)
- Just put your frontend files in the `adpay/` folder next to `adpay-server/`

Option 2: Deploy frontend separately to Netlify/Vercel
- Drag & drop your `adpay/` folder to https://app.netlify.com/drop
- Update `api.js` API_BASE to point to your backend URL
- Add your Netlify URL to the `FRONTEND_URL` in your .env

---

## ENVIRONMENT VARIABLES REFERENCE

| Variable          | Description                              | Example                    |
|-------------------|------------------------------------------|----------------------------|
| DB_HOST           | PostgreSQL host                          | localhost                  |
| DB_PORT           | PostgreSQL port                          | 5432                       |
| DB_NAME           | Database name                            | adpay                      |
| DB_USER           | Database user                            | adpay_user                 |
| DB_PASSWORD       | Database password                        | your_strong_password       |
| DB_SSL            | Use SSL (set to true for hosted DBs)     | true                       |
| JWT_SECRET        | Random 64-char hex string for JWT        | (generate below)           |
| JWT_EXPIRES_IN    | Token expiry                             | 7d                         |
| ADMIN_EMAIL       | Your admin login email                   | admin@adpay.com            |
| ADMIN_PASSWORD    | Your admin login password                | Admin@Secure2025!          |
| ADMIN_ACCESS_KEY  | Third admin auth factor                  | AP-MASTER-KEY              |
| PORT              | Server port                              | 3000                       |
| FRONTEND_URL      | Your frontend URL for CORS               | https://adpay.netlify.app  |

**Generate JWT_SECRET:**
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

---

## API ENDPOINTS SUMMARY

### Auth
| Method | Endpoint           | Description              |
|--------|--------------------|--------------------------|
| POST   | /api/auth/register | Register new user        |
| POST   | /api/auth/login    | User login               |
| GET    | /api/auth/me       | Get current user profile |

### Ads
| Method | Endpoint             | Description                    |
|--------|----------------------|--------------------------------|
| GET    | /api/ads             | List active ads (+ watched?)   |
| POST   | /api/ads/:id/watch   | Record ad view + credit user   |

### Wallet
| Method | Endpoint                  | Description              |
|--------|---------------------------|--------------------------|
| GET    | /api/wallet               | Balance + recent txns    |
| POST   | /api/wallet/deposit       | Deposit funds            |
| POST   | /api/wallet/withdraw      | Request withdrawal       |
| GET    | /api/wallet/transactions  | Full transaction history |

### Admin (JWT required, role=admin)
| Method | Endpoint                            | Description              |
|--------|-------------------------------------|--------------------------|
| POST   | /api/admin/login                    | Admin login              |
| GET    | /api/admin/stats                    | Platform overview stats  |
| GET    | /api/admin/users                    | All users (+ search)     |
| PATCH  | /api/admin/users/:id/status         | Suspend/activate user    |
| GET    | /api/admin/transactions             | All transactions         |
| PATCH  | /api/admin/transactions/:id/approve | Approve withdrawal       |
| PATCH  | /api/admin/transactions/:id/reject  | Reject & refund          |
| GET    | /api/admin/ads                      | All ads (incl. paused)   |
| POST   | /api/admin/ads                      | Create ad                |
| PATCH  | /api/admin/ads/:id                  | Update ad                |
| DELETE | /api/admin/ads/:id                  | Delete ad                |
| GET    | /api/admin/analytics                | Leaderboard + top ads    |
| GET    | /api/admin/log                      | Activity log             |
| GET    | /api/admin/events                   | SSE real-time stream     |

---

## HOW REAL-TIME WORKS

When a user registers, watches an ad, or makes a transaction:
1. The frontend calls the API (`POST /api/ads/:id/watch` etc.)
2. The server writes to PostgreSQL
3. The server broadcasts an SSE event to all connected admin dashboards
4. The admin dashboard receives the event and re-fetches the relevant data
5. The admin panel updates instantly — no page refresh needed

---

## SECURITY NOTES

- JWT tokens expire after 7 days (configurable in .env)
- Admin tokens expire after 8 hours
- Rate limiting: 200 req/15min general, 20 req/15min on auth routes
- Passwords are hashed with bcrypt (cost factor 10)
- Admin credentials are stored in .env, never in the database
- One ad view per user per day enforced at DB level (UNIQUE constraint)
- All SQL uses parameterized queries (no SQL injection possible)
- CORS restricted to your FRONTEND_URL
