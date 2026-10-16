create table users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  password_hash text not null
);

create table orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  status text not null,
  total_cents integer not null,
  paylode_charge_id text,
  failure_code text,
  created_at timestamptz not null default now()
);

create table order_items (
  order_id uuid not null references orders(id),
  sku text not null,
  quantity integer not null,
  unit_price_cents integer not null
);
