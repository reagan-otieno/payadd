-- AdPay PostgreSQL Schema
-- Run this once to set up your database:
--   psql -U postgres -c "CREATE DATABASE adpay;"
--   psql -U postgres -d adpay -f schema.sql

-- ============================================
-- EXTENSIONS
-- ============================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================
-- USERS
-- ============================================
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          VARCHAR(100) NOT NULL,
  email         VARCHAR(255) UNIQUE NOT NULL,
  phone         VARCHAR(30),
  password_hash VARCHAR(255) NOT NULL,
  balance       DECIMAL(12,2) DEFAULT 0.00,
  ads_watched   INTEGER DEFAULT 0,
  total_earned  DECIMAL(12,2) DEFAULT 0.00,
  referrals     INTEGER DEFAULT 0,
  referred_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  ref_code      VARCHAR(30) UNIQUE,
  tier          VARCHAR(20) DEFAULT 'Starter',
  status        VARCHAR(20) DEFAULT 'active',
  role          VARCHAR(20) DEFAULT 'user',
  joined_at     TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT valid_status CHECK (status IN ('active','suspended')),
  CONSTRAINT valid_role   CHECK (role   IN ('user','admin')),
  CONSTRAINT valid_tier   CHECK (tier   IN ('Starter','Regular','Pro Earner'))
);

CREATE INDEX idx_users_email  ON users(email);
CREATE INDEX idx_users_status ON users(status);
CREATE INDEX idx_users_tier   ON users(tier);

-- ============================================
-- ADS
-- ============================================
CREATE TABLE IF NOT EXISTS ads (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          VARCHAR(100) NOT NULL,
  category      VARCHAR(30)  NOT NULL,
  pay           DECIMAL(8,4) NOT NULL CHECK (pay >= 0.01),
  icon          VARCHAR(10)  DEFAULT '📱',
  duration      INTEGER      DEFAULT 30 CHECK (duration BETWEEN 5 AND 300),
  views         INTEGER      DEFAULT 0,
  status        VARCHAR(20)  DEFAULT 'active',
  description   TEXT,
  video_url     TEXT,
  thumbnail_url TEXT,
  schedule      JSONB,
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  DEFAULT NOW(),
  CONSTRAINT valid_status CHECK (status IN ('active','paused'))
);

CREATE INDEX idx_ads_status   ON ads(status);
CREATE INDEX idx_ads_category ON ads(category);

-- ============================================
-- TRANSACTIONS
-- ============================================
CREATE TABLE IF NOT EXISTS transactions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type          VARCHAR(20) NOT NULL,
  amount        DECIMAL(12,2) NOT NULL,
  method        VARCHAR(50),
  description   TEXT,
  status        VARCHAR(20) DEFAULT 'completed',
  metadata      JSONB,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT valid_type   CHECK (type   IN ('earning','deposit','withdrawal')),
  CONSTRAINT valid_status CHECK (status IN ('pending','completed','rejected'))
);

CREATE INDEX idx_transactions_user_id    ON transactions(user_id);
CREATE INDEX idx_transactions_type       ON transactions(type);
CREATE INDEX idx_transactions_status     ON transactions(status);
CREATE INDEX idx_transactions_created_at ON transactions(created_at DESC);

-- ============================================
-- AD VIEWS (which user watched which ad)
-- ============================================
CREATE TABLE IF NOT EXISTS ad_views (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ad_id      UUID NOT NULL REFERENCES ads(id)   ON DELETE CASCADE,
  earned     DECIMAL(8,4) NOT NULL,
  viewed_at  TIMESTAMPTZ DEFAULT NOW(),
  view_date  DATE GENERATED ALWAYS AS (viewed_at::DATE) STORED,
  UNIQUE(user_id, ad_id, view_date)  -- one view per ad per user per day
);

CREATE INDEX idx_ad_views_user_id  ON ad_views(user_id);
CREATE INDEX idx_ad_views_ad_id    ON ad_views(ad_id);
CREATE INDEX idx_ad_views_date     ON ad_views(view_date);

-- ============================================
-- NOTIFICATIONS
-- ============================================
CREATE TABLE IF NOT EXISTS notifications (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  icon       VARCHAR(10),
  title      VARCHAR(100) NOT NULL,
  body       TEXT,
  is_read    BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_notif_user_id ON notifications(user_id);
CREATE INDEX idx_notif_unread  ON notifications(user_id) WHERE is_read = FALSE;

-- ============================================
-- ADMIN ACTIVITY LOG
-- ============================================
CREATE TABLE IF NOT EXISTS admin_log (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  icon       VARCHAR(10),
  action     TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- AUTO-UPDATE updated_at TRIGGER
-- ============================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ads_updated_at
  BEFORE UPDATE ON ads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_transactions_updated_at
  BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================
-- SEED ADS
-- ============================================
INSERT INTO ads (name, category, pay, icon, duration, views, status, description) VALUES
  ('GameZone Pro',      'gaming',    0.50, '🎮', 30, 1204, 'active', 'Action-packed mobile gaming app'),
  ('CryptoWallet X',    'finance',   0.60, '💰', 25,  887, 'active', 'Secure crypto wallet & trading'),
  ('FitLife Coach',     'lifestyle', 0.45, '🏋️', 20,  643, 'active', 'Personal fitness & nutrition'),
  ('ShopEasy',          'shopping',  0.40, '🛍️', 15, 1567, 'active', 'Online shopping made easy'),
  ('MusicPro Studio',   'lifestyle', 0.35, '🎵', 20,  422, 'active', 'Create & discover music'),
  ('LearnFast Academy', 'education', 0.55, '📚', 35,  299, 'active', 'Online courses & skill building'),
  ('RideShare Go',      'lifestyle', 0.50, '🚕', 25,  754, 'active', 'Affordable city rides app'),
  ('FoodDash Delivery', 'shopping',  0.45, '🍔', 20,  932, 'active', 'Fast food delivery service'),
  ('InvestSmart',       'finance',   0.65, '📈', 30,  188, 'paused', 'Smart investing platform'),
  ('TravelLite',        'lifestyle', 0.40, '✈️', 25,  367, 'active', 'Budget travel booking app')
ON CONFLICT DO NOTHING;

-- ============================================
-- SEED DEMO USER (password: "password")
-- ============================================
INSERT INTO users (name, email, phone, password_hash, balance, ads_watched, total_earned, referrals, tier, ref_code)
VALUES (
  'Ashley Kim',
  'ashley@example.com',
  '+1-512-345-6789',
  '$2b$10$rOzJqFQXGp1IzRkVNYnKAuDKvDXxFJXKmJkNpN8GzFJkVFkZxRKmq',
  47.20, 94, 89.50, 5, 'Pro Earner', 'ADPAY-ASHL'
) ON CONFLICT (email) DO NOTHING;
