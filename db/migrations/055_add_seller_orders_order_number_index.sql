-- online: an index; the build holds writes to seller_orders only while it reads the table's few
-- thousand rows, and the running release's queries are unchanged.
-- Postage purchases name their orders by number alone, and the economics evidence counts each
-- purchase's orders and their sellers by that number (inventoryEconomics, ledger/evidence.rs). The
-- unique index leads with seller_key, so each lookup read the whole table: 1,583 purchases took
-- 8 s on the dev copy, and 0.25 s with this index.
CREATE INDEX IF NOT EXISTS seller_orders_order_number_idx ON seller_orders (order_number);
