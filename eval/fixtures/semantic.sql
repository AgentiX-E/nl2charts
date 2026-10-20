-- Deterministic warehouse fixture for semantic compiler tests.
-- 40 orders, 2-3 items each (a deliberate 1:N join), 10 customers.
create table customers as
select
  i as customer_id,
  (['smb', 'enterprise', 'consumer'])[1 + (i % 3)] as segment,
  (['north', 'south', 'east', 'west'])[1 + (i % 4)] as region,
  'user' || i || '@example.com' as email
from range(1, 11) t(i);

create table orders as
select
  i as order_id,
  1 + (i % 10) as customer_id,
  DATE '2026-01-01' + CAST(i * 3 AS INTEGER) as order_date,
  (['north', 'south', 'east', 'west'])[1 + (i % 4)] as region,
  (['web', 'store'])[1 + (i % 2)] as channel,
  CAST((10 + ((i * 17) % 200)) / 10.0 AS DECIMAL(10, 2)) as amount,
  CAST((10 + ((i * 17) % 200)) / 100.0 AS DECIMAL(10, 2)) as tax,
  (['completed', 'completed', 'completed', 'refunded'])[1 + (i % 4)] as status
from range(1, 41) t(i);

create table order_items as
select
  i * 10 + j as item_id,
  i as order_id,
  1 + (j % 3) as quantity,
  CAST(5 + (i % 7) AS DECIMAL(10, 2)) as price
from range(1, 41) t(i), range(1, 4) t2(j);
