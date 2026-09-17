-- Purchase costs may be negative when a lot is worth less than its handling
-- deduction: the seller effectively pays to have it taken. Explicit per-lot
-- allocations and the netted purchase total carry that sign.
ALTER TABLE inventory_purchase_cost_entries
  DROP CONSTRAINT inventory_purchase_cost_entries_total_amount_cents_check;
ALTER TABLE inventory_purchase_cost_allocations
  DROP CONSTRAINT inventory_purchase_cost_allocation_allocated_amount_cents_check,
  DROP CONSTRAINT inventory_purchase_cost_allocations_allocation_weight_check;