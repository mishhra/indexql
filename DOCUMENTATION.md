# IndexQL Documentation

IndexQL is a SQL-ish query builder backed by IndexedDB with a fluent JavaScript client and an optional SQL parser.

## Installation

This project is a plain JS module. Import it directly in the browser or Node:

```js
import { IndexQL } from "./indexql.js";
```

## Quick Start

````js
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
````

# IndexQL: Complete Documentation & Tutorial

## Table of Contents

1. [Introduction](#introduction)
2. [Installation & Setup](#installation--setup)
3. [Schema Definition](#schema-definition)
4. [Core API Overview](#core-api-overview)
5. [Column References & Keywords](#column-references--keywords)
6. [Query Builder: Fluent API](#query-builder-fluent-api)
7. [SQL Parser: Syntax & Features](#sql-parser-syntax--features)
8. [Supported Functions](#supported-functions)
9. [Nested JSON & Arrays](#nested-json--arrays)
10. [Transactions](#transactions)
11. [Dummy Data Seeding](#dummy-data-seeding)
12. [Error Handling & Edge Cases](#error-handling--edge-cases)
13. [Reference: All Keywords, Operators, and Functions](#reference-all-keywords-operators-and-functions)
14. [Advanced Usage & Notes](#advanced-usage--notes)

---

## 1. Introduction

IndexQL brings SQL-like querying and a fluent API to IndexedDB, supporting:
- SELECT/INSERT/UPDATE/DELETE/DDL (CREATE, DROP, SHOW, TRUNCATE)
- Joins, grouping, aggregates, math/string functions
- Nested JSON fields, arrays, dot/arrow notation
- ACID transactions, dummy data seeding, error handling

---

## 2. Installation & Setup

Import in browser or Node.js:

```js
import { IndexQL } from "./indexql.js";
````

Open a database (empty schema allowed):

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
    products: {
      keyPath: "id",
      autoIncrement: true,
    },
  },
});
```

You can also open with an empty schema and create tables later via SQL:

```js
const db = await IndexQL.open("playground", { tables: {} });
```

---

## 3. Schema Definition

Each table in `tables` can specify:

- `keyPath`: Primary key field (string)
- `autoIncrement`: Boolean (true/false)
- `indexes`: Object of `{ field: { unique?: true, multiEntry?: true } }`

Example:

```js
tables: {
  users: {
    keyPath: "id",
    autoIncrement: true,
    indexes: {
      email: { unique: true },
      age: {},
    },
  },
  posts: {
    keyPath: "postId",
    autoIncrement: true,
    indexes: {
      userId: {},
    },
  },
}
```

You can also create/drop tables at runtime using SQL DDL commands.

---

## 4. Core API Overview

### IndexQL

- `IndexQL.open(name, schema)` — Open or create a database
- `db.table(name)` — Get a table instance
- `db.sql(query)` — Parse SQL to a query builder
- `db.sqlMulti(query)` — Run multiple SQL statements
- `db.cols(tableName)` — Get a column proxy for a table
- `db.k` — Keyword object (operators, join types, etc.)
- `db.fn` — All math, string, and aggregate functions
- `db.transaction(storeNames, mode, fn)` — ACID transaction
- `db.populateDummy(options)` — Seed with DummyJSON data
- `db.close()` — Close the database

### Table

- `table.c` — Column proxy (unqualified)
- `table.k` — Keywords (same as `db.k`)
- `table.fn` — Functions (same as `db.fn`)
- `table.cols(tableName)` — Qualified column proxy
- `table.select(fields)` — Start SELECT query
- `table.insert(data)` — Start INSERT query
- `table.update(data)` — Start UPDATE query
- `table.delete()` — Start DELETE query

### QueryBuilder (from select/insert/update/delete)

- `select(fields)` — Specify fields (array or null for \*)
- `where(field, op, value)` — Add WHERE clause
- `orWhere(field, op, value)` — OR-combined WHERE
- `join(table, leftField, rightField, type)` — Add JOIN
- `groupBy(fields)` — GROUP BY
- `aggregate(spec)` — Aggregates (object of { alias: fn })
- `having(field, op, value)` — HAVING clause
- `orHaving(field, op, value)` — OR-combined HAVING
- `orderBy(field, direction)` — ORDER BY
- `limit(count)` — LIMIT
- `offset(count)` — OFFSET
- `insert(data)` — For INSERT
- `update(data)` — For UPDATE
- `exec()` — Execute query

---

## 5. Column References & Keywords

### Column Proxies

Use column proxies for type-safe, error-proof field references:

```js
const users = db.table("users");
const u = users.c;
const k = db.k;
await users.select([u.id, u.name]).where(u.age, k.gte, 18).exec();
```

For joins, use qualified columns:

```js
const orders = db.table("orders");
const o = orders.c;
const usersCols = db.cols("users");
await orders
  .select([usersCols.name, o.amount])
  .join("users", o.userId, usersCols.id, k.left)
  .exec();
```

### Keywords

`db.k` exposes all operators, join types, and boolean keywords:

| Name    | Value     | Purpose          |
| ------- | --------- | ---------------- |
| asc     | "asc"     | Sort ascending   |
| desc    | "desc"    | Sort descending  |
| inner   | "inner"   | Inner join       |
| left    | "left"    | Left join        |
| right   | "right"   | Right join       |
| and     | "and"     | Logical AND      |
| or      | "or"      | Logical OR       |
| like    | "like"    | Pattern matching |
| between | "between" | Range operator   |
| is      | "is"      | IS NULL          |
| isNot   | "is not"  | IS NOT NULL      |
| not     | "not"     | Negation         |
| null    | null      | Null literal     |
| eq      | "="       | Equality         |
| ne      | "!="      | Not equal        |
| gt      | ">"       | Greater than     |
| gte     | ">="      | Greater or equal |
| lt      | "<"       | Less than        |
| lte     | "<="      | Less or equal    |
| in      | "in"      | IN list          |

---

## 6. Query Builder: Fluent API

### SELECT

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

### INSERT

```js
await users.insert({ name: "Ada" }).exec();
await users.insert([{ name: "Bob" }, { name: "Carol" }]).exec();
```

### UPDATE

```js
await users.update({ active: true }).where(u.age, k.gte, 18).exec();
```

### DELETE

```js
await users.delete().where(u.age, k.lt, 18).exec();
```

### JOIN

```js
await orders
  .select([usersCols.name, o.amount])
  .join("users", o.userId, usersCols.id, k.inner)
  .exec();
```

### GROUP BY & HAVING

```js
await orders
  .groupBy([usersCols.name])
  .aggregate({ total: db.fn.sum(o.amount) })
  .having("total", k.gt, 25)
  .exec();
```

---

## 7. SQL Parser: Syntax & Features

### SELECT

```sql
SELECT [TOP n] field_list | * FROM table
  [LEFT|RIGHT|INNER JOIN table2 ON field1 = field2]...
  [WHERE conditions]
  [GROUP BY field1, field2]
  [HAVING conditions]
  [ORDER BY field [ASC|DESC]]
  [LIMIT n]
  [OFFSET n | SKIP n]
```

**Features:**

- Wildcard: `SELECT *`
- Aliasing: `SELECT field AS alias`
- Aggregates: `COUNT(*)`, `SUM(field)`, etc.
- Scalar functions: `UPPER(name)`, `ROUND(price, 2)`, etc.
- Inline math: `price * 0.9`, `age + 1`
- Auto GROUP BY: If SELECT has both plain fields and aggregates, plain fields become group key
- Independent SELECT: `SELECT 1+2`, `SELECT UPPER('hi')` (no FROM)

### INSERT

```sql
INSERT INTO table (col1, col2) VALUES (v1, v2), (v3, v4)
INSERT INTO table SET col1 = v1, col2 = v2
```

- Supports multiple rows, nested JSON, arrays, function expressions

### UPDATE

```sql
UPDATE table SET col1 = v1, col2 = v2 [WHERE ...]
```

- SET values can be functions, math, JSON

### DELETE

```sql
DELETE FROM table WHERE ...
```

- **DELETE without WHERE is blocked** (use TRUNCATE)

### DDL

```sql
SHOW TABLES
SHOW COLUMNS FROM table
DESCRIBE table
CREATE TABLE [IF NOT EXISTS] name (col defs)
DROP TABLE [IF EXISTS] name
TRUNCATE [TABLE] name
```

### Multi-Query

```js
const results = await db.sqlMulti(
  "INSERT INTO products (name, price) VALUES ('Widget', 10); SELECT * FROM products",
);
// [{ query, rows, error }, ...]
```

### Comments

- Single-line: `-- comment`
- Multi-line: `/* comment */`
- Comments inside strings are preserved

---

## 8. Supported Functions

### Aggregate Functions

| Name  | Usage         | Notes                      |
| ----- | ------------- | -------------------------- |
| count | count(field?) | `count(*)` counts all rows |
| sum   | sum(field)    |                            |
| avg   | avg(field)    |                            |
| min   | min(field)    |                            |
| max   | max(field)    |                            |

### Math Functions

| Name  | Aliases  | Usage             | Notes                    |
| ----- | -------- | ----------------- | ------------------------ |
| add   |          | add(a, b)         | `a + b`                  |
| sub   | subtract | sub(a, b)         | `a - b`                  |
| mul   | multiply | mul(a, b)         | `a * b`                  |
| div   | divide   | div(a, b)         | `a / b` (throws on zero) |
| mod   | modulo   | mod(a, b)         | `a % b` (throws on zero) |
| pow   |          | pow(a, b)         | `a ** b`                 |
| abs   |          | abs(a)            |                          |
| ceil  |          | ceil(a)           |                          |
| floor |          | floor(a)          |                          |
| round |          | round(a, digits?) | digits default 0         |
| sqrt  |          | sqrt(a)           | throws on negative       |

### String Functions

| Name        | Aliases   | Usage                       | Notes                        |
| ----------- | --------- | --------------------------- | ---------------------------- |
| concat      |           | concat(a, b, ...)           |                              |
| trim        |           | trim(a)                     |                              |
| trimStart   | trimLeft  | trimStart(a)                |                              |
| trimEnd     | trimRight | trimEnd(a)                  |                              |
| slice       |           | slice(a, start, end)        |                              |
| substring   |           | substring(a, start, end)    |                              |
| substr      |           | substr(a, start, length)    |                              |
| toUpperCase |           | toUpperCase(a)              |                              |
| toLowerCase |           | toLowerCase(a)              |                              |
| replace     |           | replace(a, search, repl)    |                              |
| replaceAll  |           | replaceAll(a, search, repl) | regex, throws on bad pattern |
| split       |           | split(a, sep)               |                              |
| startsWith  |           | startsWith(a, prefix)       |                              |
| endsWith    |           | endsWith(a, suffix)         |                              |
| includes    |           | includes(a, substr)         |                              |
| indexOf     |           | indexOf(a, search)          |                              |
| length      |           | length(a)                   |                              |

---

## 9. Nested JSON & Arrays

### Dot Notation & Arrow Operators

- Access nested fields: `user.profile.name`, `specs.storage.size`
- PostgreSQL-style: `specs->'cpu'`, `specs->>'ram'` (converted to dot notation)

### Array Access

- `tags[0]` or `tags.0`
- `items[0].name` or `items.0.name`

### Examples

```js
await products
  .select(["name", "specs.cpu"])
  .where("specs.ram", k.like, "%GB")
  .exec();
await db
  .sql("select name, tags[0] from products where tags[0] = 'electronics'")
  .exec();
await db.sql("select items[0].name from orders").exec();
```

---

## 10. Transactions

ACID transactions across multiple tables:

```js
await db.transaction(["users", "orders"], "readwrite", async (tx) => {
  await tx.table("users").insert({ name: "Nora" }).exec();
  await tx.table("orders").insert({ userId: 1, amount: 42 }).exec();
});
```

All operations in the callback share a single IndexedDB transaction. Use `tx.table(name)`, `tx.sql(query)`, `tx.sqlMulti(query)`, `tx.cols(tableName)`.

---

## 11. Dummy Data Seeding

Seed tables with realistic data from [dummyjson.com](https://dummyjson.com):

```js
await db.populateDummy({
  users: { mode: "replace", limit: 50 },
  products: true,
  carts: { limit: 20 },
});
// { users: 50, products: 30, carts: 20 }
```

**Resources:** products, carts, users, posts, comments, quotes, todos

**Options:**

- `baseUrl`, `resources`, `mode`, `limit`, `skip`, `all`, `skipMissing`, `tableMap`, `fetch`
- Per-resource config supported

---

## 12. Error Handling & Edge Cases

### Error Types

| Error                                           | Condition                          |
| ----------------------------------------------- | ---------------------------------- |
| "Schema object is required"                     | No schema passed                   |
| "Unknown table: X"                              | Table not in schema                |
| "select(fields) expects an array"               | Non-array argument                 |
| "where(field, op, value) requires a field name" | Falsy field                        |
| "Division by zero"                              | Math div/mod by zero               |
| "Invalid argument for SQRT: negative value"     | SQRT of negative                   |
| "REPLACE: invalid pattern"                      | Bad regex in replaceAll            |
| "DELETE without WHERE would remove all rows..." | DELETE without WHERE               |
| "Duplicate key: ..."                            | IndexedDB ConstraintError          |
| "Table X already exists"                        | CREATE TABLE without IF NOT EXISTS |
| "INSERT requires at least one row"              | Empty INSERT                       |
| "UPDATE requires at least one SET assignment"   | Empty UPDATE                       |
| "Unknown function: X"                           | Unrecognized function              |
| "Unsupported SQL command: X"                    | Unrecognized command               |
| "Invalid SELECT syntax"                         | SELECT without FROM                |
| "DummyJSON request failed: X"                   | Dummy data fetch error             |
| ...and more                                     |

### Null Propagation

- Math functions return null if any operand is null/undefined/NaN
- String functions: null/undefined → "" or default (see function table)

### Safety

- DELETE without WHERE is blocked (use TRUNCATE)
- All DDL commands are transactional (schema changes are atomic)

---

## 13. Reference: All Keywords, Operators, and Functions

### Keywords

See [Column References & Keywords](#column-references--keywords)

### WHERE Operators

| SQL         | API     | Meaning          |
| ----------- | ------- | ---------------- |
| =           | eq      | Equal            |
| !=          | ne      | Not equal        |
| <>          | ne      | Not equal        |
| >           | gt      | Greater than     |
| >=          | gte     | Greater or equal |
| <           | lt      | Less than        |
| <=          | lte     | Less or equal    |
| IN          | in      | In list          |
| BETWEEN     | between | Range            |
| LIKE        | like    | Pattern match    |
| IS NULL     | is      | Null check       |
| IS NOT NULL | isNot   | Not null         |

### Logical

- AND, OR, NOT, parentheses supported

### Join Types

- INNER, LEFT, RIGHT

### DDL

- SHOW TABLES, SHOW COLUMNS, DESCRIBE, CREATE TABLE, DROP TABLE, TRUNCATE

### Functions

- See [Supported Functions](#supported-functions)

---

## 14. Advanced Usage & Notes

### Wildcard SELECT

- `SELECT *` or `table.select(null)` returns full row objects

### Aliasing

- `SELECT field AS alias` or function/aggregate AS alias

### Inline Math

- `SELECT price * 0.9 AS discounted FROM products`

### Function Expressions in INSERT/UPDATE

- `INSERT INTO users (name) VALUES (UPPER('alice'))`
- `UPDATE users SET age = age + 1 WHERE ...`

### Multi-Query

- `db.sqlMulti("...; ...")` returns array of results/errors

### Comments

- `-- comment` and `/* comment */` supported

### Transactions

- All table/sql operations in a transaction share the same IndexedDB tx

### Dummy Data

- `populateDummy` fetches all data before opening tx (avoids timeout)

### Schema Reconstruction

- On open, schema is reconstructed from existing stores if not provided

### Limitations

- No DISTINCT or subquery support
- No ALTER TABLE

---

## 15. Full Example: End-to-End

```js
import { IndexQL } from "./indexql.js";

// Open DB with empty schema
const db = await IndexQL.open("demo", { tables: {} });

// Create table via SQL
await db.sql("CREATE TABLE users (id PRIMARY KEY, name, age, email)").exec();

// Insert data
await db
  .sql(
    "INSERT INTO users (name, age, email) VALUES ('Alice', 30, 'alice@test'), ('Bob', 25, 'bob@test')",
  )
  .exec();

// Query with math, string, and aggregate functions
const rows = await db
  .sql(
    `
  SELECT UPPER(name) AS uname, age + 1 AS nextAge, COUNT(*) AS total
  FROM users
  WHERE age >= 25
  GROUP BY name, age
  ORDER BY age DESC
`,
  )
  .exec();

// Transaction
await db.transaction(["users"], "readwrite", async (tx) => {
  await tx
    .table("users")
    .update({ active: true })
    .where("age", db.k.gte, 18)
    .exec();
});

// Seed dummy data
await db.populateDummy({ users: { limit: 10 } });

// Clean up
await db.close();
```

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

`db.sql(...)` returns a query builder. Call `.exec()` to run it.

### SELECT

- `SELECT ... FROM ...`
- `LEFT/RIGHT/INNER JOIN ... ON a = b`
- `WHERE` with `AND`, `OR`, parentheses, `IN`, `BETWEEN`, `LIKE`, `IS NULL`, `IS NOT NULL`
- `GROUP BY` and `HAVING`
- `ORDER BY`, `LIMIT`, `OFFSET`, `TOP`, `SKIP`
- Scalar functions: `UPPER()`, `LOWER()`, `TRIM()`, `CONCAT()`, `LENGTH()`, `REPLACE()`, `ROUND()`, `ABS()`, etc.
- Inline math: `price * 0.9`, `age + 1`
- Independent SELECT (no FROM): `SELECT 1 + 2 AS sum`, `SELECT UPPER('hello')`

```js
const rows = await db
  .sql(
    "SELECT users.firstName, SUM(orders.amount) AS total FROM orders LEFT JOIN users ON orders.userId = users.id WHERE users.active = true GROUP BY users.name HAVING total > 25 ORDER BY total DESC LIMIT 5",
  )
  .exec();
```

### INSERT

```js
// Single row
await db
  .sql(
    "INSERT INTO users (name, email, age) VALUES ('Alice', 'alice@test', 30)",
  )
  .exec();

// Multiple rows
await db
  .sql(
    "INSERT INTO products (name, price) VALUES ('Laptop', 1200), ('Phone', 800)",
  )
  .exec();

// SET syntax
await db
  .sql("INSERT INTO users SET name = 'Bob', email = 'bob@test', age = 25")
  .exec();

// Nested JSON objects and arrays
await db
  .sql(
    "INSERT INTO products (name, meta) VALUES ('Widget', {'color': 'red', 'weight': 150})",
  )
  .exec();
await db
  .sql(
    "INSERT INTO products (name, tags) VALUES ('Gadget', ['electronics', 'sale'])",
  )
  .exec();

// Deeply nested structures
await db
  .sql(
    "INSERT INTO products (name, details) VALUES ('Phone', {'specs': {'ram': 8}, 'colors': ['black', 'white']})",
  )
  .exec();

// Array of objects
await db
  .sql(
    "INSERT INTO products (name, variants) VALUES ('Shirt', [{'size': 'S', 'stock': 10}, {'size': 'M', 'stock': 20}])",
  )
  .exec();

// SET syntax with nested JSON
await db
  .sql(
    "INSERT INTO products SET name = 'Laptop', specs = {'cpu': 'i7', 'ram': 16}",
  )
  .exec();
```

### UPDATE

```js
// Update with WHERE
await db.sql("UPDATE users SET age = 31 WHERE name = 'Alice'").exec();

// Update all rows
await db.sql("UPDATE users SET active = false").exec();

// Update multiple columns
await db
  .sql("UPDATE users SET name = 'Alicia', age = 31 WHERE email = 'alice@test'")
  .exec();
```

### DELETE

```js
// Delete with WHERE
await db.sql("DELETE FROM users WHERE age < 18").exec();

// Delete all rows
await db.sql("DELETE FROM users").exec();
```

### DDL Commands

```js
// Show all tables
await db.sql("SHOW TABLES").exec();

// Show columns of a table (also: DESCRIBE users, DESC users)
await db.sql("SHOW COLUMNS FROM users").exec();

// Create a new table
await db.sql("CREATE TABLE tasks (id PRIMARY KEY, title, done)").exec();

// Create only if it doesn't exist
await db.sql("CREATE TABLE IF NOT EXISTS tasks (id, title)").exec();

// Drop a table
await db.sql("DROP TABLE tasks").exec();

// Drop only if it exists
await db.sql("DROP TABLE IF EXISTS tasks").exec();

// Truncate (clear all rows, keep table)
await db.sql("TRUNCATE TABLE users").exec();
await db.sql("TRUNCATE users").exec();
```

### Multi-Query

Run multiple statements separated by `;` or newlines:

```js
const results = await db.sqlMulti(
  "INSERT INTO products (name, price) VALUES ('Widget', 10); SELECT * FROM products",
);
// results = [{ query, rows, error }, { query, rows, error }]
```

### Comments

Single-line (`--`) and multi-line (`/* ... */`) comments are supported:

```sql
-- This is a single-line comment
SELECT * FROM users LIMIT 5

SELECT * FROM users WHERE /* only adults */ age >= 18

/*
 * Multi-line comment
 * spanning several lines
 */
SELECT * FROM products
```

Comments inside quoted strings are preserved (not stripped).

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
- `sql()` supports SELECT, INSERT, UPDATE, DELETE, and DDL commands (SHOW TABLES, CREATE TABLE, DROP TABLE, TRUNCATE).
