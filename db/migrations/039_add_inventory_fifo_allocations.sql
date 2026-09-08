CREATE TABLE inventory_stock_dispositions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  seller_key TEXT NOT NULL CHECK (length(trim(seller_key)) > 0),
  order_id BIGINT NOT NULL REFERENCES seller_orders(id) ON DELETE RESTRICT,
  order_line_sku_id TEXT NOT NULL CHECK (length(trim(order_line_sku_id)) > 0),
  sku INTEGER NOT NULL CHECK (sku > 0),
  disposition_type TEXT NOT NULL CHECK (disposition_type IN ('unfulfilled_cancellation','physical_restock')),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  source_order_revision INTEGER NOT NULL CHECK (source_order_revision > 0),
  source_ordered_quantity INTEGER NOT NULL CHECK (source_ordered_quantity > 0),
  available_at TIMESTAMPTZ NOT NULL,
  evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, seller_key, sku)
);

CREATE TABLE inventory_stock_disposition_receipts (
  disposition_id BIGINT NOT NULL REFERENCES inventory_stock_dispositions(id) ON DELETE RESTRICT,
  source_supply_key TEXT NOT NULL CHECK (length(trim(source_supply_key)) > 0),
  receipt_id INTEGER NOT NULL REFERENCES inventory_receipts(receipt_id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (disposition_id, source_supply_key)
);

CREATE TABLE inventory_stock_disposition_corrections (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  disposition_id BIGINT NOT NULL UNIQUE REFERENCES inventory_stock_dispositions(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action = 'provider_revision_accounts_for_return'),
  source_order_revision INTEGER NOT NULL CHECK (source_order_revision > 0),
  evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  confirmed_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE inventory_fifo_lines (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  seller_key TEXT NOT NULL CHECK (length(trim(seller_key)) > 0),
  order_id BIGINT NOT NULL REFERENCES seller_orders(id) ON DELETE RESTRICT,
  order_line_sku_id TEXT NOT NULL CHECK (length(trim(order_line_sku_id)) > 0),
  sku INTEGER,
  order_time TIMESTAMPTZ NOT NULL,
  ordered_quantity INTEGER NOT NULL CHECK (ordered_quantity >= 0),
  source_order_revision INTEGER NOT NULL CHECK (source_order_revision > 0),
  state TEXT NOT NULL CHECK (state IN ('pending','allocated','partial','unmatched','held','unsupported','excluded_pre_cutoff','removed')),
  hold_reason TEXT,
  matched_quantity INTEGER NOT NULL CHECK (matched_quantity >= 0),
  unmatched_quantity INTEGER NOT NULL CHECK (unmatched_quantity >= 0),
  price_known_quantity INTEGER NOT NULL CHECK (price_known_quantity >= 0),
  date_known_quantity INTEGER NOT NULL CHECK (date_known_quantity >= 0),
  intake_market_total NUMERIC(14,2),
  weighted_days_held NUMERIC(14,6),
  current_revision_id BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (order_id, order_line_sku_id),
  CHECK (sku IS NULL OR sku > 0),
  CHECK (matched_quantity + unmatched_quantity = ordered_quantity),
  CHECK (price_known_quantity <= matched_quantity AND date_known_quantity <= matched_quantity),
  CHECK ((price_known_quantity = 0 AND intake_market_total IS NULL) OR
         (price_known_quantity > 0 AND intake_market_total IS NOT NULL)),
  CHECK ((date_known_quantity = 0 AND weighted_days_held IS NULL) OR
         (date_known_quantity > 0 AND weighted_days_held IS NOT NULL))
);

CREATE INDEX inventory_fifo_lines_seller_sku_idx
  ON inventory_fifo_lines (seller_key, sku, order_time, order_id) WHERE sku IS NOT NULL;
CREATE INDEX inventory_fifo_lines_order_idx ON inventory_fifo_lines (order_id, id);

CREATE TABLE inventory_fifo_revisions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  line_id BIGINT NOT NULL REFERENCES inventory_fifo_lines(id) ON DELETE RESTRICT,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  source_order_revision INTEGER NOT NULL CHECK (source_order_revision > 0),
  order_time TIMESTAMPTZ NOT NULL,
  trigger_reason TEXT NOT NULL,
  state TEXT NOT NULL,
  hold_reason TEXT,
  ordered_quantity INTEGER NOT NULL CHECK (ordered_quantity >= 0),
  matched_quantity INTEGER NOT NULL CHECK (matched_quantity >= 0),
  unmatched_quantity INTEGER NOT NULL CHECK (unmatched_quantity >= 0),
  price_known_quantity INTEGER NOT NULL CHECK (price_known_quantity >= 0),
  date_known_quantity INTEGER NOT NULL CHECK (date_known_quantity >= 0),
  intake_market_total NUMERIC(14,2),
  weighted_days_held NUMERIC(14,6),
  source_fingerprint TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (line_id, revision_number)
);

CREATE TABLE inventory_fifo_revision_allocations (
  revision_id BIGINT NOT NULL REFERENCES inventory_fifo_revisions(id) ON DELETE RESTRICT,
  supply_key TEXT NOT NULL,
  receipt_id INTEGER NOT NULL REFERENCES inventory_receipts(receipt_id) ON DELETE RESTRICT,
  disposition_id BIGINT REFERENCES inventory_stock_dispositions(id) ON DELETE RESTRICT,
  allocated_quantity INTEGER NOT NULL CHECK (allocated_quantity > 0),
  available_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (revision_id, supply_key)
);

ALTER TABLE inventory_fifo_lines
  ADD CONSTRAINT inventory_fifo_lines_current_revision_fk
  FOREIGN KEY (current_revision_id) REFERENCES inventory_fifo_revisions(id) ON DELETE RESTRICT;

CREATE TABLE inventory_fifo_replay_queue (
  seller_key TEXT NOT NULL CHECK (length(trim(seller_key)) > 0),
  sku INTEGER NOT NULL CHECK (sku > 0),
  affected_from TIMESTAMPTZ NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','held')),
  claim_token UUID,
  claim_expires_at TIMESTAMPTZ,
  hold_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (seller_key, sku),
  CHECK (
    (status='processing' AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL AND hold_reason IS NULL)
    OR (status='pending' AND claim_token IS NULL AND claim_expires_at IS NULL AND hold_reason IS NULL)
    OR (status='held' AND claim_token IS NULL AND claim_expires_at IS NULL AND hold_reason IS NOT NULL)
  )
);

CREATE INDEX inventory_fifo_replay_queue_pending_idx
  ON inventory_fifo_replay_queue (updated_at, seller_key, sku) WHERE status='pending';

-- Existing order history predates the replay queue. Seed each seller/SKU once;
-- later order, opening, publication, and disposition transactions maintain the queue.
INSERT INTO inventory_fifo_lines
  (seller_key,order_id,order_line_sku_id,sku,order_time,ordered_quantity,source_order_revision,state,
   matched_quantity,unmatched_quantity,price_known_quantity,date_known_quantity)
SELECT orders.seller_key,orders.id,line.sku_id,line.sku_id::bigint::integer,orders.order_time,
  line.ordered_quantity,orders.source_revision,'pending',0,line.ordered_quantity,0,0
FROM seller_orders orders JOIN seller_order_lines line ON line.order_id=orders.id
WHERE line.sku_id~'^[1-9][0-9]{0,9}$' AND line.sku_id::bigint BETWEEN 1 AND 2147483647;

INSERT INTO inventory_fifo_replay_queue (seller_key,sku,affected_from,status,generation)
SELECT orders.seller_key,line.sku_id::bigint::integer,MIN(orders.order_time),'pending',1
FROM seller_orders orders
JOIN seller_order_lines line ON line.order_id=orders.id
WHERE line.sku_id~'^[1-9][0-9]{0,9}$'
  AND line.sku_id::bigint BETWEEN 1 AND 2147483647
GROUP BY orders.seller_key,line.sku_id::bigint;
