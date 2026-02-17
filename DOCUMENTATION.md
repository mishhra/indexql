# IndexQL Documentation

IndexQL is a SQL-ish query builder backed by IndexedDB with a fluent JavaScript client and an optional SQL parser.

## Installation

This project is a plain JS module. Import it directly in the browser or Node:

```js
import { IndexQL } from "./indexql.js";
```

## Quick Start

```js
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

const users = db.table("users");
const u = users.c;
const k = db.k;

const rows = await users
  .select([u.id, u.name])
  .where(u.age, k.gte, 18)
  .orderBy(u.age, k.desc)
  .limit(10)
  .exec();
```

## Schema

`IndexQL.open(name, schema)` expects a schema with `tables`. `version` is optional and defaults to 1.

```js
const db = await IndexQL.open("demo", {
  version: 2,
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
```

## Core API

### IndexQL

- `IndexQL.open(name, schema)`
- `db.table(name)`
- `db.sql(query)`
- `db.cols(tableName)`
- `db.transaction(storeNames, mode, fn)`
- `db.populateDummy(options)`
- `db.close()`

### Table

- `table.c` (column reference proxy)
- `table.k` (keyword proxy, same as `db.k`)
- `table.fn` (aggregate helpers, same as `db.fn`)
- `table.cols(tableName)`
- `table.select(fields)`
- `table.insert(data)`
- `table.update(data)`
- `table.delete()`

### QueryBuilder (returned from select/insert/update/delete)

- `select(fields)`
- `where(field, op, value)`
- `orWhere(field, op, value)`
- `join(tableName, leftField, rightField, type)`
- `groupBy(fields)`
- `aggregate(spec)`
- `having(field, op, value)`
- `orHaving(field, op, value)`
- `orderBy(field, direction)`
- `limit(count)`
- `offset(count)`
- `insert(data)`
- `update(data)`
- `exec()`

## Column References

Use column proxies instead of strings:

```js
const users = db.table("users");
const u = users.c;
const k = db.k;

await users.select([u.id, u.name]).where(u.age, k.gte, 18).exec();
```

Use qualified columns for joins:

```js
const orders = db.table("orders");
const o = orders.c;
const usersCols = db.cols("users");

await orders
  .select([usersCols.name, o.amount])
  .join("users", o.userId, usersCols.id, k.left)
  .exec();
```

## Keywords

`db.k` exposes keyword objects so you do not need string literals:

- Direction: `asc`, `desc`
- Join types: `inner`, `left`, `right`
- Operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `like`, `between`, `is`, `isNot`
- Boolean: `and`, `or`, `not`, `null`

Example:

```js
const k = db.k;
await users.where(u.email, k.like, "%@dev").orderBy(u.id, k.asc).exec();
```

## Aggregates

`db.fn` exposes aggregate builders:

- `count(field?)`
- `sum(field)`
- `avg(field)`
- `min(field)`
- `max(field)`

Example:

```js
await orders
  .groupBy([usersCols.name])
  .aggregate({ total: db.fn.sum(o.amount), count: db.fn.count() })
  .exec();
```

## Select Queries

```js
const rows = await users
  .select([u.id, u.name])
  .where(u.age, k.between, [18, 65])
  .orWhere(u.email, k.like, "%@dev")
  .orderBy(u.age, k.desc)
  .limit(10)
  .offset(0)
  .exec();
```

## Insert/Update/Delete

```js
await users.insert({ name: "Ada" }).exec();
await users.update({ active: true }).where(u.age, k.gte, 18).exec();
await users.delete().where(u.age, k.lt, 18).exec();
```

## Joins

```js
await orders
  .select([usersCols.name, o.amount])
  .join("users", o.userId, usersCols.id, k.inner)
  .exec();
```

Join types: `k.inner`, `k.left`, `k.right`.

## Group By and Having

```js
await orders
  .select([usersCols.name])
  .join("users", o.userId, usersCols.id)
  .groupBy([usersCols.name])
  .aggregate({ total: db.fn.sum(o.amount) })
  .having("total", k.gt, 25)
  .exec();
```

## Transactions

```js
await db.transaction(["users", "orders"], "readwrite", async (tx) => {
  await tx.table("users").insert({ name: "Nora" }).exec();
  await tx.table("orders").insert({ userId: 1, amount: 42 }).exec();
});
```

## SQL Parser

`db.sql(...)` supports:

- `select ... from ...`
- `left/right/inner join ... on a = b`
- `where` with `and`, `or`, parentheses, `in`, `between`, `like`, `is null`, `is not null`
- `group by` and `having`
- `order by`, `limit`, `offset`

Example:

```js
const sqlRows = await db
  .sql(
    "select users.firstName, sum(orders.amount) as total from orders left join users on orders.userId = users.id where (users.active = true and orders.amount > 10) or users.email like '%@dev' group by users.name having total > 25 order by total desc limit 5",
  )
  .exec();
```

## Nested JSON Objects

Access nested object properties using dot notation or PostgreSQL-style arrow operators. Supports arbitrary nesting depth.

### Dot Notation (Fluent API and SQL)

Use dot notation to access nested properties:

```js
const products = db.table("products");
const p = products.c;

// Single-level nesting
await products
  .select(["name", "specs.cpu"])
  .where(p["specs.cpu"], k.like, "%Intel%")
  .exec();

// Multi-level nesting
await products
  .select(["name", "specs.storage.size"])
  .where(p["specs.storage.size"], k.eq, "512GB")
  .orderBy(p["specs.storage.type"], k.asc)
  .exec();
```

For nested fields in the fluent API, use bracket notation: `p["specs.ram"]` or `p["specs.storage.type"]`.

### SQL with Nested Properties

Access nested fields directly in SQL queries:

```js
// Single-level nesting
const rows = await db
  .sql("select name, specs.cpu from products where specs.ram = '16GB'")
  .exec();

// Multi-level nesting
const rows = await db
  .sql(
    "select name from products where specs.storage.type = 'SSD' order by specs.storage.size",
  )
  .exec();

// Combining with joins and aggregates
const rows = await db
  .sql(
    "select name, count(*) as cnt from products where specs.cpu like '%Intel%' group by specs.cpu",
  )
  .exec();
```

### PostgreSQL Arrow Operators

Equivalent to dot notation. The `->` and `->>` operators are converted to dot notation internally:

```js
// These are equivalent:
db.sql("select name from products where specs->'cpu' = 'Intel i7'");
db.sql("select name from products where specs.cpu = 'Intel i7'");
```

### Array Element Access

Access array elements using bracket notation or dot notation with numeric indices:

```js
// Bracket notation (conventional)
const rows = await db
  .sql("select name, tags[0] from products where tags[0] = 'electronics'")
  .exec();

// Dot notation equivalent
const rows = await db
  .sql("select name, tags.0 from products where tags.0 = 'electronics'")
  .exec();

// Mixed with nested objects: get first item's property
const rows = await db.sql("select items[0].name from orders").exec();
```

### Use Cases

- **Product specifications**: `product.specs.cpu`, `product.specs.storage.size`
- **Product tags**: `product.tags[0]`, `product.tags[1]`
- **User profiles**: `user.profile.address.city`, `user.profile.phone.mobile`
- **Order items**: `order.items[0].name`, `order.items[0].price`
- **Configuration objects**: `config.settings.theme.dark`, `config.api.endpoints.users`
- **Nested metadata**: `item.meta.tags.categories`, `item.meta.timestamps.created`

### Notes

- Nested properties are fully supported in `select()`, `where()`, `orWhere()`, `orderBy()`, and `having()` clauses.
- Non-existent nested paths return `undefined`.
- Missing intermediate objects treat the entire path as undefined (e.g., if `config.settings` doesn't exist, `config.settings.theme` is undefined).

## Math Operations

Use `db.fn` to perform arithmetic operations on numeric fields:

```js
const products = db.table("products");

// Basic arithmetic
const rows = await products.select(["name", db.fn.add("price", 10)]).exec();

// More complex operations
const calculated = await products
  .select([
    "name",
    db.fn.round(db.fn.div("price", 2), 2), // Divide by 2 and round to 2 decimals
    db.fn.mul("quantity", "price"), // Multiply quantity by price
  ])
  .exec();
```

### Math Functions

- `add(field, value)` - Addition
- `sub(field, value)` or `subtract(field, value)` - Subtraction
- `mul(field, value)` or `multiply(field, value)` - Multiplication
- `div(field, value)` or `divide(field, value)` - Division
- `mod(field, value)` or `modulo(field, value)` - Modulo (remainder)
- `pow(field, exponent)` - Power
- `abs(field)` - Absolute value
- `ceil(field)` - Ceiling (round up)
- `floor(field)` - Floor (round down)
- `round(field, digits)` - Round to N decimal places (default 0)
- `sqrt(field)` - Square root

Math functions can be nested and used in `select()`:

```js
const rows = await products
  .select(["name", db.fn.round(db.fn.sqrt(db.fn.add("price", 100)), 2)])
  .exec();
```

## String Operations

Use `db.fn` to manipulate string fields:

```js
const users = db.table("users");

// Transform strings
const rows = await users
  .select([
    db.fn.toUpperCase("name"),
    db.fn.concat("firstName", " ", "lastName"),
    db.fn.trim("email"),
  ])
  .exec();

// Extract and search
const textRows = await users
  .select([
    "name",
    db.fn.slice("bio", 0, 50), // First 50 characters
    db.fn.indexOf("bio", "hello"), // Find position of substring
  ])
  .exec();
```

### String Functions

**Case conversion:**

- `toUpperCase(field)` - Convert to uppercase
- `toLowerCase(field)` - Convert to lowercase

**Whitespace:**

- `trim(field)` - Remove leading and trailing whitespace
- `trimStart(field)` or `trimLeft(field)` - Remove leading whitespace
- `trimEnd(field)` or `trimRight(field)` - Remove trailing whitespace

**Substring operations:**

- `slice(field, start, end)` - Extract substring from start to end
- `substring(field, start, end)` - Extract substring from start to end
- `substr(field, start, length)` - Extract substring starting at start with length

**Search and replace:**

- `indexOf(field, searchStr)` - Find position of substring (returns -1 if not found)
- `includes(field, substring)` - Check if string contains substring (returns boolean)
- `startsWith(field, prefix)` - Check if string starts with prefix (returns boolean)
- `endsWith(field, suffix)` - Check if string ends with suffix (returns boolean)
- `replace(field, search, replaceWith)` - Replace first occurrence
- `replaceAll(field, search, replaceWith)` - Replace all occurrences

**String manipulation:**

- `concat(...fields)` - Concatenate multiple fields or strings
- `length(field)` - Get string length
- `split(field, separator)` - Split string into array

### Examples

```js
const users = db.table("users");

// Full name with proper formatting
const rows = await users
  .select([
    db.fn.concat(
      db.fn.toUpperCase(db.fn.slice("firstName", 0, 1)),
      db.fn.slice("firstName", 1),
      " ",
      "lastName",
    ),
  ])
  .exec();

// Filter by string length
const shortNames = await users
  .select(["name"])
  .where(db.fn.length("name"), db.k.lt, 10)
  .exec();

// Email validation with includes
const emailUsers = await users
  .select(["name", "email"])
  .where(db.fn.includes("email", "@"))
  .exec();
```

## Dummy Data Seeding (DummyJSON)

`db.populateDummy(options)` pulls from https://dummyjson.com and inserts rows into your tables.

### Supported resources

- products
- carts
- users
- posts
- comments
- quotes
- todos

### Example

```js
const seeded = await db.populateDummy({
  users: { mode: "replace", limit: 50 },
  products: true,
  carts: { limit: 20 },
});
// seeded => { users: 50, products: 30, carts: 20 }
```

### Options

- `baseUrl` (string) Base URL, default `https://dummyjson.com`
- `resources` (string[]) Only load these resources
- `mode` (string) Default write mode: `append` or `replace`
- `limit` (number) Default per-resource limit
- `skip` (number) Default per-resource skip
- `all` (boolean) Fetch all pages
- `skipMissing` (boolean) Skip resources without tables instead of throwing
- `tableMap` (object) Map resource names to table names
- `fetch` (function) Custom fetch implementation (required if `fetch` is not global)

Per-resource options are also accepted, e.g. `users: { limit: 50, mode: "replace" }`.

### Node.js

If `fetch` is not available, pass your own:

```js
import fetch from "node-fetch";

await db.populateDummy({
  users: { limit: 25 },
  fetch,
});
```

## Error Handling and Notes

- Joins and aggregations are performed in memory.
- Queries that cannot use indexes are filtered in memory.
- `populateDummy` uses `put()` to upsert rows.
- `sql()` supports SELECT only.
