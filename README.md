# IndexQL

IndexQL is a small SQL-ish query builder that runs in the browser using IndexedDB. This gives ACID-like transactional behavior in a way that localStorage cannot provide.

## Why not localStorage

localStorage is a simple key/value store with no transactions, no concurrent writes, and no indexing. IndexedDB provides transactions, indexing, and durability.

## Usage

```js
import { IndexQL } from "./indexql.js";

const db = await IndexQL.open("demo", {
  tables: {
    users: {
      keyPath: "id",
      autoIncrement: true,
      indexes: {
        email: { unique: true },
        age: {},
      },
    },
  },
});

// Insert
await db
  .table("users")
  .insert({ name: "Ada", email: "ada@dev", age: 33 })
  .exec();

// DummyJSON population
const seeded = await db.populateDummy({
  users: { mode: "replace", limit: 50 },
  products: true,
  carts: { limit: 20 },
});

// Select
const users = db.table("users");
const u = users.c;
const k = db.k;

const rows = await users
  .select([u.id, u.name])
  .where(u.age, k.between, [18, 65])
  .orWhere(u.email, k.like, "%@dev")
  .orderBy(u.age, k.desc)
  .limit(10)
  .exec();

// Update
await db.table("users").update({ active: true }).where("age", ">=", 18).exec();

// Delete
await db.table("users").delete().where("age", "<", 18).exec();

// Transaction
await db.transaction(["users"], "readwrite", async (tx) => {
  await tx.table("users").insert({ name: "Nora" }).exec();
  await tx
    .table("users")
    .update({ active: true })
    .where("name", "=", "Nora")
    .exec();
});

// Join + groupBy + aggregates
const orders = db.table("orders");
const o = orders.c;
const usersCols = db.cols("users");

const totals = await orders
  .select([usersCols.name])
  .join("users", o.userId, usersCols.id, k.left)
  .groupBy([usersCols.name])
  .aggregate({ total: db.fn.sum(o.amount), count: db.fn.count() })
  .orderBy("total", k.desc)
  .exec();

// Right join
const rightJoinRows = await orders
  .select([usersCols.name, o.amount])
  .join("users", o.userId, usersCols.id, k.right)
  .exec();

// SQL parser
const sqlRows = await db
  .sql(
    "select users.firstName, sum(orders.amount) as total from orders left join users on orders.userId = users.id where (users.active = true and orders.amount > 10) or users.email like '%@dev' group by users.name having total > 25 order by total desc limit 5",
  )
  .exec();
```

## Query features

- select, insert, update, delete
- where with operators: =, !=, >, >=, <, <=, in
- extra operators: like, between, is, is not
- orderBy, limit, offset
- joins (inner/left/right)
- groupBy + aggregates (count, sum, avg, min, max)
- having
- transactions
- lightweight SQL select parser (parentheses + having)
- dummy data seeding (DummyJSON)

## Notes

- Queries that cannot be satisfied by indexes are filtered in memory after fetching rows.
- Joins and aggregations are performed in memory after reading matching rows.
- If you need schema upgrades later, add a `version` and increment it when the schema changes.

## Full documentation

See [DOCUMENTATION.md](DOCUMENTATION.md) for complete API coverage, SQL syntax, and seeding options.
