-- Deterministic fixture for the benchmark harness. 200 orders across 4 regions,
-- 2 channels, 3 products and 90 days. No external data, no randomness.
create table orders as
select
  i as order_id,
  DATE '2026-01-01' + CAST(i % 90 AS INTEGER) as order_date,
  (['north', 'south', 'east', 'west'])[1 + (i % 4)] as region,
  (['web', 'store'])[1 + (i % 2)] as channel,
  (['widget', 'gadget', 'gizmo'])[1 + (i % 3)] as product,
  CAST(((i * 37) % 500) AS DECIMAL(10, 2)) / 10 as amount,
  1 + (i % 5) as quantity
from range(1, 201) t(i);

create table customers as
select
  i as customer_id,
  (['north', 'south', 'east', 'west'])[1 + (i % 4)] as region,
  (['smb', 'enterprise', 'consumer'])[1 + (i % 3)] as segment
from range(1, 61) t(i);
