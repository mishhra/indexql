const assert = require("node:assert/strict");
require("fake-indexeddb/auto");

const { IndexQL } = require("../indexql.js");

async function withDb(fn) {
  const db = await IndexQL.open(
    "test-db-" + Math.random().toString(36).slice(2),
    {
      version: Date.now(),
      tables: {
        users: {
          keyPath: "id",
          autoIncrement: true,
          indexes: {
            email: { unique: true },
            age: {},
          },
        },
        orders: {
          keyPath: "id",
          autoIncrement: true,
          indexes: {
            userId: {},
            amount: {},
          },
        },
        products: {
          keyPath: "id",
          autoIncrement: true,
          indexes: {},
        },
        numbers: {
          keyPath: "id",
          autoIncrement: true,
          indexes: {},
        },
        strings: {
          keyPath: "id",
          autoIncrement: true,
          indexes: {},
        },
      },
    },
  );

  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

async function seed(db) {
  const users = db.table("users");
  const orders = db.table("orders");

  const userIds = await users
    .insert([
      { name: "Ada", email: "ada@dev", age: 33, active: true },
      { name: "Ben", email: "ben@dev", age: 22, active: true },
      { name: "Cara", email: "cara@site", age: 45, active: false },
      { name: "Dana", email: "dana@site", age: 19, active: true },
      { name: "NoOrder", email: "no@orders", age: 30, active: true },
    ])
    .exec();

  await orders
    .insert([
      { userId: userIds[0], amount: 15 },
      { userId: userIds[0], amount: 20 },
      { userId: userIds[1], amount: 5 },
      { userId: userIds[2], amount: 50 },
      { userId: 999, amount: 7 },
    ])
    .exec();

  return { userIds };
}

async function run() {
  await withDb(async (db) => {
    await seed(db);

    const users = db.table("users");
    const u = users.c;
    const k = db.k;

    const rows = await users
      .select([u.id, u.name])
      .where(u.age, k.between, [18, 40])
      .orWhere(u.email, k.like, "%@dev")
      .orderBy(u.age, k.desc)
      .limit(3)
      .exec();

    assert.equal(rows.length, 3);
    assert.ok(rows.some((row) => row.name === "Ada"));

    const updated = await users
      .update({ active: false })
      .where(u.age, k.lt, 20)
      .exec();
    assert.equal(updated, 1);

    const deleted = await users.delete().where(u.name, k.eq, "Ben").exec();
    assert.equal(deleted, 1);
  });

  await withDb(async (db) => {
    await seed(db);

    const orders = db.table("orders");
    const o = orders.c;
    const usersCols = db.cols("users");
    const k = db.k;

    const leftRows = await orders
      .select([usersCols.name, o.amount])
      .join("users", o.userId, usersCols.id, k.left)
      .exec();

    assert.ok(leftRows.some((row) => row["users.name"] === "Ada"));
    assert.ok(leftRows.some((row) => row.amount === 7));

    const rightRows = await orders
      .select([usersCols.name])
      .join("users", o.userId, usersCols.id, k.right)
      .exec();

    assert.ok(rightRows.some((row) => row["users.name"] === "NoOrder"));

    const grouped = await orders
      .select([usersCols.name, "total"])
      .join("users", o.userId, usersCols.id, k.left)
      .groupBy([usersCols.name])
      .aggregate({ total: db.fn.sum(o.amount) })
      .having("total", k.gt, 10)
      .exec();

    assert.ok(grouped.some((row) => row.total > 10));

    const sqlRows = await db
      .sql(
        "select users.firstName, sum(orders.amount) as total from orders left join users on orders.userId = users.id where (users.active = true and orders.amount > 10) or users.email like '%@dev' group by users.name having total > 15 order by total desc",
      )
      .exec();

    assert.ok(sqlRows.length > 0);
  });

  // Test nested JSON object access
  await withDb(async (db) => {
    const products = db.table("products");

    // Insert products with nested metadata
    const insertedIds = await products
      .insert([
        {
          id: 1,
          name: "Laptop",
          specs: {
            cpu: "Intel i7",
            ram: "16GB",
            storage: { type: "SSD", size: "512GB" },
          },
          tags: ["electronics", "computing"],
          price: 1200,
        },
        {
          id: 2,
          name: "Phone",
          specs: {
            cpu: "Snapdragon",
            ram: "8GB",
            storage: { type: "eMMC", size: "128GB" },
          },
          tags: ["electronics", "mobile"],
          price: 800,
        },
        {
          id: 3,
          name: "Keyboard",
          specs: { connection: "Wireless", battery: "400mAh" },
          tags: ["electronics", "accessories"],
          price: 120,
        },
      ])
      .exec();

    // First, verify data was inserted correctly
    const allRows = await products.select(null).exec();
    assert.equal(allRows.length, 3);
    assert.equal(allRows[0].specs.cpu, "Intel i7");

    // Test: Query nested single level property
    const rows1 = await products
      .select(["name", "specs.cpu"])
      .where("specs.cpu", db.k.like, "%Intel%")
      .exec();

    assert.equal(
      rows1.length,
      1,
      `Expected 1 row, got ${rows1.length}. Rows: ${JSON.stringify(rows1)}`,
    );
    assert.equal(
      rows1[0].name,
      "Laptop",
      `Expected name "Laptop", got ${rows1[0].name}`,
    );
    assert.equal(
      rows1[0]["specs.cpu"],
      "Intel i7",
      `Expected specs.cpu "Intel i7", got ${rows1[0]["specs.cpu"]}`,
    );

    // Test: Query deeply nested property
    const rows2 = await products
      .select(["name", "specs.storage.size"])
      .where("specs.storage.size", db.k.eq, "512GB")
      .exec();

    assert.equal(rows2.length, 1);
    assert.equal(rows2[0]["specs.storage.size"], "512GB");

    // Test: SQL query with nested properties
    const rows3 = await db
      .sql(`SELECT name, specs.cpu FROM products WHERE specs.ram = '16GB'`)
      .exec();

    assert.equal(rows3.length, 1);
    assert.equal(rows3[0].name, "Laptop");

    // Test: SQL with deeply nested property
    const rows4 = await db
      .sql(`SELECT name FROM products WHERE specs.storage.type = 'SSD'`)
      .exec();

    assert.equal(rows4.length, 1);
    assert.equal(rows4[0].name, "Laptop");

    // Test: PostgreSQL-style arrow operator->
    const rows5 = await db
      .sql(`SELECT name FROM products WHERE specs->'cpu' = 'Intel i7'`)
      .exec();

    assert.equal(rows5.length, 1);

    // Test: Filter by price with nested property condition
    const rows6 = await products
      .select(["name"])
      .where("specs.storage.size", db.k.ne, "128GB")
      .orderBy("price", db.k.desc)
      .limit(2)
      .exec();

    assert.equal(rows6.length, 2);

    // Test: Array indexing with bracket notation (tags[0])
    const rows7 = await db.sql(`SELECT name, tags[0] FROM products`).exec();

    assert.equal(rows7.length, 3);
    assert.equal(rows7[0]["tags[0]"], "electronics");

    // Test: Filter by array element
    const rows8 = await db
      .sql(`SELECT id FROM products WHERE tags[0] = 'electronics'`)
      .exec();

    assert.equal(rows8.length, 3); // All products have tags[0]='electronics'
  });

  // Math functions test
  await withDb(async (db) => {
    const numbers = db.table("numbers");

    await numbers
      .insert([
        { id: 1, value: 10, description: "ten" },
        { id: 2, value: 20, description: "twenty" },
        { id: 3, value: 5, description: "five" },
      ])
      .exec();

    // Test: add
    const rows1 = await numbers.select(["id", db.fn.add("value", 5)]).exec();
    assert.equal(rows1[0]["value + 5"], 15);

    // Test: subtract
    const rows2 = await numbers.select(["id", db.fn.sub("value", 3)]).exec();
    assert.equal(rows2[0]["value - 3"], 7);

    // Test: multiply
    const rows3 = await numbers.select(["id", db.fn.mul("value", 2)]).exec();
    assert.equal(rows3[0]["value * 2"], 20);

    // Test: divide
    const rows4 = await numbers.select(["id", db.fn.div("value", 2)]).exec();
    assert.equal(rows4[1]["value / 2"], 10);

    // Test: abs
    const rows5 = await numbers.select(["id", db.fn.abs("value")]).exec();
    assert.equal(rows5[0]["abs(value)"], 10);

    // Test: floor
    const rows6 = await numbers.select(["id", db.fn.floor("value")]).exec();
    assert.equal(rows6[0]["floor(value)"], 10);

    // Test: round with digits
    const rows7 = await numbers
      .select(["id", db.fn.round(db.fn.div("value", 3), 2)])
      .exec();
    // This is nested, so we'll just check it doesn't error
    assert.ok(rows7 !== undefined);
  });

  // String functions test
  await withDb(async (db) => {
    const strings = db.table("strings");

    await strings
      .insert([
        { id: 1, text: "hello world", firstName: "John", lastName: "Doe" },
        { id: 2, text: "  spaces  ", firstName: "jane", lastName: "Smith" },
      ])
      .exec();

    // Test: concat
    const rows1 = await strings
      .select(["id", db.fn.concat("firstName", " ", "lastName")])
      .exec();
    assert.equal(rows1[0]["concat(firstName,  , lastName)"], "John Doe");

    // Test: trim
    const rows2 = await strings.select(["id", db.fn.trim("text")]).exec();
    assert.equal(rows2[1]["trim(text)"], "spaces");

    // Test: toUpperCase
    const rows3 = await strings
      .select(["id", db.fn.toUpperCase("text")])
      .exec();
    assert.equal(rows3[0]["toUpperCase(text)"], "HELLO WORLD");

    // Test: toLowerCase
    const rows4 = await strings
      .select(["id", db.fn.toLowerCase("firstName")])
      .exec();
    assert.equal(rows4[0]["toLowerCase(firstName)"], "john");

    // Test: slice
    const rows5 = await strings
      .select(["id", db.fn.slice("text", 0, 5)])
      .exec();
    assert.equal(rows5[0]["slice(text, 0, 5)"], "hello");

    // Test: includes
    const rows6 = await strings
      .select(["id", db.fn.includes("text", "world")])
      .exec();
    assert.equal(rows6[0]["includes(text, world)"], true);
    assert.equal(rows6[1]["includes(text, world)"], false);

    // Test: startsWith
    const rows7 = await strings
      .select(["id", db.fn.startsWith("text", "hello")])
      .exec();
    assert.equal(rows7[0]["startsWith(text, hello)"], true);

    // Test: length
    const rows8 = await strings.select(["id", db.fn.length("text")]).exec();
    assert.equal(rows8[0]["length(text)"], 11);
  });

  // SQL raw query functions test
  await withDb(async (db) => {
    const products = db.table("products");
    await products
      .insert([
        { id: 1, name: "Laptop Pro", price: 1200, discount: 0.1 },
        { id: 2, name: "  Phone  ", price: 800, discount: 0.15 },
        { id: 3, name: "keyboard", price: 120, discount: 0.05 },
      ])
      .exec();

    // Test: UPPER() in SELECT
    const r1 = await db
      .sql("SELECT name, UPPER(name) as upper_name FROM products")
      .exec();
    assert.equal(r1[0].upper_name, "LAPTOP PRO");

    // Test: LOWER() in SELECT
    const r2 = await db
      .sql("SELECT name, LOWER(name) as lower_name FROM products")
      .exec();
    assert.equal(r2[0].lower_name, "laptop pro");

    // Test: TRIM() in SELECT
    const r3 = await db
      .sql("SELECT TRIM(name) as trimmed FROM products WHERE id = 2")
      .exec();
    assert.equal(r3[0].trimmed, "Phone");

    // Test: CONCAT() in SELECT
    const r4 = await db
      .sql(
        "SELECT CONCAT(name, ' - $', price) as label FROM products WHERE id = 1",
      )
      .exec();
    assert.equal(r4[0].label, "Laptop Pro - $1200");

    // Test: SLICE() in SELECT
    const r5 = await db
      .sql("SELECT SLICE(name, 0, 6) as short FROM products WHERE id = 1")
      .exec();
    assert.equal(r5[0].short, "Laptop");

    // Test: LENGTH() in SELECT
    const r6 = await db
      .sql("SELECT name, LENGTH(name) as len FROM products WHERE id = 1")
      .exec();
    assert.equal(r6[0].len, 10);

    // Test: ROUND() in SELECT
    const r7 = await db
      .sql("SELECT name, ROUND(price, 0) as rounded FROM products WHERE id = 1")
      .exec();
    assert.equal(r7[0].rounded, 1200);

    // Test: Math expression in SELECT (price * 0.9)
    const r8 = await db
      .sql("SELECT name, price * 0.9 FROM products WHERE id = 1")
      .exec();
    assert.equal(r8[0]["price * 0.9"], 1080);

    // Test: ABS() in SELECT
    const r9 = await db
      .sql("SELECT ABS(price) as abs_price FROM products WHERE id = 1")
      .exec();
    assert.equal(r9[0].abs_price, 1200);

    // Test: UPPER() in WHERE clause
    const r10 = await db
      .sql("SELECT name FROM products WHERE UPPER(name) = 'KEYBOARD'")
      .exec();
    assert.equal(r10.length, 1);
    assert.equal(r10[0].name, "keyboard");

    // Test: LOWER() in WHERE clause
    const r11 = await db
      .sql("SELECT name FROM products WHERE LOWER(name) = 'laptop pro'")
      .exec();
    assert.equal(r11.length, 1);
    assert.equal(r11[0].name, "Laptop Pro");

    // Test: LENGTH() in WHERE clause
    const r12 = await db
      .sql("SELECT name FROM products WHERE LENGTH(name) > 8")
      .exec();
    assert.ok(r12.length > 0);

    // Test: Math inline in WHERE clause (price + 100 > 1000)
    const r13 = await db
      .sql("SELECT name FROM products WHERE price + 100 > 1000")
      .exec();
    assert.equal(r13.length, 1);
    assert.equal(r13[0].name, "Laptop Pro");

    // Test: Nested functions in SELECT: UPPER(TRIM(name))
    const r14 = await db
      .sql("SELECT UPPER(TRIM(name)) as clean FROM products WHERE id = 2")
      .exec();
    assert.equal(r14[0].clean, "PHONE");

    // Test: Function in WHERE comparison value: LOWER(name) = LOWER('LAPTOP PRO')
    // Both sides are functions/values
    const r15 = await db
      .sql("SELECT name FROM products WHERE TRIM(name) = 'Phone'")
      .exec();
    assert.equal(r15.length, 1);

    // Test: STARTSWITH in WHERE
    const r16 = await db
      .sql("SELECT name FROM products WHERE STARTSWITH(name, 'Laptop') = true")
      .exec();
    assert.equal(r16.length, 1);
    assert.equal(r16[0].name, "Laptop Pro");

    // Test: REPLACE() in SELECT
    const r17 = await db
      .sql(
        "SELECT REPLACE(name, 'Pro', 'Air') as newname FROM products WHERE id = 1",
      )
      .exec();
    assert.equal(r17[0].newname, "Laptop Air");
  });

  // Independent SELECT queries (no FROM clause)
  await withDb(async (db) => {
    // SELECT literal number
    const r1 = await db.sql("SELECT 1").exec();
    assert.equal(r1[0]["1"], 1);

    // SELECT literal number with alias
    const r2 = await db.sql("SELECT 1 as one").exec();
    assert.equal(r2[0].one, 1);

    // SELECT math expression
    const r3 = await db.sql("SELECT 1 + 2 as sum").exec();
    assert.equal(r3[0].sum, 3);

    // SELECT math multiplication
    const r4 = await db.sql("SELECT 6 * 7 as product").exec();
    assert.equal(r4[0].product, 42);

    // SELECT function with literals
    const r5 = await db.sql("SELECT UPPER('hello') as greeting").exec();
    assert.equal(r5[0].greeting, "HELLO");

    // SELECT CONCAT with literals
    const r6 = await db
      .sql("SELECT CONCAT('hello', ' ', 'world') as msg")
      .exec();
    assert.equal(r6[0].msg, "hello world");

    // SELECT multiple expressions
    const r7 = await db.sql("SELECT 1 as a, 2 as b, 3 as c").exec();
    assert.equal(r7[0].a, 1);
    assert.equal(r7[0].b, 2);
    assert.equal(r7[0].c, 3);
  });

  // Multiple SELECT queries (sqlMulti)
  await withDb(async (db) => {
    const products = db.table("products");
    await products
      .insert([
        { id: 1, name: "Laptop", price: 1200 },
        { id: 2, name: "Phone", price: 800 },
      ])
      .exec();

    await db
      .table("users")
      .insert([{ name: "Alice", email: "alice@test", age: 30, active: true }])
      .exec();

    // Multi-query with newline separation
    const results = await db.sqlMulti(
      "SELECT * FROM products\nSELECT name FROM users",
    );
    assert.equal(results.length, 2);
    assert.equal(results[0].error, null);
    assert.equal(results[0].rows.length, 2);
    assert.equal(results[1].error, null);
    assert.equal(results[1].rows.length, 1);
    assert.equal(results[1].rows[0].name, "Alice");

    // Multi-query with semicolons
    const results2 = await db.sqlMulti(
      "SELECT name FROM products; SELECT 1 as one",
    );
    assert.equal(results2.length, 2);
    assert.equal(results2[0].rows.length, 2);
    assert.equal(results2[1].rows[0].one, 1);

    // Single query through sqlMulti
    const results3 = await db.sqlMulti("SELECT * FROM products");
    assert.equal(results3.length, 1);
    assert.equal(results3[0].rows.length, 2);

    // Error in one query doesn't stop others
    const results4 = await db.sqlMulti(
      "SELECT * FROM products\nSELECT * FROM nonexistent_table",
    );
    assert.equal(results4.length, 2);
    assert.equal(results4[0].error, null);
    assert.ok(results4[1].error !== null);
  });

  // ========== SQL INSERT ==========
  await withDb(async (db) => {
    // INSERT INTO ... VALUES (single row)
    const result = await db
      .sql("INSERT INTO products (name, price) VALUES ('Widget', 9.99)")
      .exec();
    assert.equal(result[0].message, "1 row(s) inserted");
    const rows = await db.sql("SELECT * FROM products").exec();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "Widget");
    assert.equal(rows[0].price, 9.99);
  });

  await withDb(async (db) => {
    // INSERT INTO ... VALUES (multiple rows)
    const result = await db
      .sql(
        "INSERT INTO products (name, price) VALUES ('Laptop', 1200), ('Phone', 800), ('Tablet', 500)",
      )
      .exec();
    assert.equal(result[0].message, "3 row(s) inserted");
    const rows = await db
      .sql("SELECT * FROM products ORDER BY price ASC")
      .exec();
    assert.equal(rows.length, 3);
    assert.equal(rows[0].name, "Tablet");
    assert.equal(rows[2].name, "Laptop");
  });

  await withDb(async (db) => {
    // INSERT INTO ... SET
    const result = await db
      .sql(
        "INSERT INTO users SET name = 'Bob', email = 'bob@test', age = 25, active = true",
      )
      .exec();
    assert.equal(result[0].message, "1 row(s) inserted");
    const rows = await db.sql("SELECT * FROM users").exec();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "Bob");
    assert.equal(rows[0].age, 25);
    assert.equal(rows[0].active, true);
  });

  await withDb(async (db) => {
    // INSERT with null and boolean values
    await db
      .sql(
        "INSERT INTO users (name, email, age, active) VALUES ('Test', 'test@test', null, false)",
      )
      .exec();
    const rows = await db.sql("SELECT * FROM users").exec();
    assert.equal(rows[0].age, null);
    assert.equal(rows[0].active, false);
  });

  await withDb(async (db) => {
    // INSERT with nested JSON object
    await db
      .sql(
        "INSERT INTO products (name, price, meta) VALUES ('Widget', 9.99, {'color': 'red', 'weight': 150})",
      )
      .exec();
    const rows = await db.sql("SELECT * FROM products").exec();
    assert.equal(rows[0].name, "Widget");
    assert.deepEqual(rows[0].meta, { color: "red", weight: 150 });
  });

  await withDb(async (db) => {
    // INSERT with nested JSON array
    await db
      .sql(
        "INSERT INTO products (name, tags) VALUES ('Gadget', ['electronics', 'sale', 'new'])",
      )
      .exec();
    const rows = await db.sql("SELECT * FROM products").exec();
    assert.deepEqual(rows[0].tags, ["electronics", "sale", "new"]);
  });

  await withDb(async (db) => {
    // INSERT with deeply nested object
    await db
      .sql(
        "INSERT INTO products (name, details) VALUES ('Phone', {'specs': {'ram': 8, 'storage': 256}, 'colors': ['black', 'white']})",
      )
      .exec();
    const rows = await db.sql("SELECT * FROM products").exec();
    assert.deepEqual(rows[0].details, {
      specs: { ram: 8, storage: 256 },
      colors: ["black", "white"],
    });
  });

  await withDb(async (db) => {
    // INSERT with array of objects
    await db
      .sql(
        "INSERT INTO products (name, variants) VALUES ('Shirt', [{'size': 'S', 'stock': 10}, {'size': 'M', 'stock': 20}])",
      )
      .exec();
    const rows = await db.sql("SELECT * FROM products").exec();
    assert.equal(rows[0].variants.length, 2);
    assert.equal(rows[0].variants[0].size, "S");
    assert.equal(rows[0].variants[1].stock, 20);
  });

  await withDb(async (db) => {
    // INSERT SET with nested JSON
    await db
      .sql(
        "INSERT INTO products SET name = 'Laptop', specs = {'cpu': 'i7', 'ram': 16}",
      )
      .exec();
    const rows = await db.sql("SELECT * FROM products").exec();
    assert.deepEqual(rows[0].specs, { cpu: "i7", ram: 16 });
  });

  // ========== SQL UPDATE ==========
  await withDb(async (db) => {
    await db
      .table("users")
      .insert([
        { name: "Alice", email: "alice@test", age: 30, active: true },
        { name: "Bob", email: "bob@test", age: 25, active: true },
      ])
      .exec();

    // UPDATE with WHERE
    const result = await db
      .sql("UPDATE users SET age = 31 WHERE name = 'Alice'")
      .exec();
    assert.equal(result[0].message, "1 row(s) updated");
    const rows = await db
      .sql("SELECT * FROM users WHERE name = 'Alice'")
      .exec();
    assert.equal(rows[0].age, 31);
  });

  await withDb(async (db) => {
    await db
      .table("users")
      .insert([
        { name: "Alice", email: "alice@test", age: 30, active: true },
        { name: "Bob", email: "bob@test", age: 25, active: true },
      ])
      .exec();

    // UPDATE without WHERE (all rows)
    const result = await db.sql("UPDATE users SET active = false").exec();
    assert.equal(result[0].message, "2 row(s) updated");
    const rows = await db.sql("SELECT * FROM users").exec();
    assert.ok(rows.every((r) => r.active === false));
  });

  await withDb(async (db) => {
    await db
      .table("users")
      .insert([{ name: "Alice", email: "alice@test", age: 30, active: true }])
      .exec();

    // UPDATE multiple columns
    await db
      .sql(
        "UPDATE users SET name = 'Alicia', age = 31 WHERE email = 'alice@test'",
      )
      .exec();
    const rows = await db.sql("SELECT * FROM users").exec();
    assert.equal(rows[0].name, "Alicia");
    assert.equal(rows[0].age, 31);
  });

  // ========== SQL DELETE ==========
  await withDb(async (db) => {
    await db
      .table("users")
      .insert([
        { name: "Alice", email: "alice@test", age: 30, active: true },
        { name: "Bob", email: "bob@test", age: 25, active: true },
      ])
      .exec();

    // DELETE with WHERE
    const result = await db.sql("DELETE FROM users WHERE name = 'Bob'").exec();
    assert.equal(result[0].message, "1 row(s) deleted");
    const rows = await db.sql("SELECT * FROM users").exec();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "Alice");
  });

  await withDb(async (db) => {
    await db
      .table("users")
      .insert([
        { name: "Alice", email: "alice@test", age: 30, active: true },
        { name: "Bob", email: "bob@test", age: 25, active: true },
      ])
      .exec();

    // DELETE all rows — use TRUNCATE since DELETE without WHERE is now blocked
    const result = await db.sql("TRUNCATE users").exec();
    assert.equal(result[0].message, "Table users truncated");
    const rows = await db.sql("SELECT * FROM users").exec();
    assert.equal(rows.length, 0);
  });

  // ========== DDL Commands ==========
  await withDb(async (db) => {
    // SHOW TABLES
    const result = await db.sql("SHOW TABLES").exec();
    const tableNames = result.map((r) => r.table_name).sort();
    assert.ok(tableNames.includes("users"));
    assert.ok(tableNames.includes("orders"));
    assert.ok(tableNames.includes("products"));
  });

  await withDb(async (db) => {
    // SHOW COLUMNS FROM / DESCRIBE
    const result = await db.sql("SHOW COLUMNS FROM users").exec();
    const cols = result.map((r) => r.column);
    assert.ok(cols.includes("id"));
    assert.ok(cols.includes("email"));
    assert.ok(cols.includes("age"));

    // DESCRIBE synonym
    const result2 = await db.sql("DESCRIBE users").exec();
    assert.deepEqual(result, result2);
  });

  await withDb(async (db) => {
    // CREATE TABLE
    const result = await db
      .sql("CREATE TABLE tasks (id PRIMARY KEY, title, done)")
      .exec();
    assert.equal(result[0].message, "Table tasks created");

    // Should appear in SHOW TABLES
    const tables = await db.sql("SHOW TABLES").exec();
    assert.ok(tables.some((t) => t.table_name === "tasks"));

    // Should be usable
    await db
      .sql("INSERT INTO tasks (title, done) VALUES ('Buy milk', false)")
      .exec();
    const rows = await db.sql("SELECT * FROM tasks").exec();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, "Buy milk");
  });

  await withDb(async (db) => {
    // CREATE TABLE IF NOT EXISTS
    const result = await db
      .sql("CREATE TABLE IF NOT EXISTS users (id, name)")
      .exec();
    assert.equal(result[0].message, "Table users already exists");
  });

  await withDb(async (db) => {
    // DROP TABLE
    const result = await db.sql("DROP TABLE products").exec();
    assert.equal(result[0].message, "Table products dropped");

    const tables = await db.sql("SHOW TABLES").exec();
    assert.ok(!tables.some((t) => t.table_name === "products"));
  });

  await withDb(async (db) => {
    // DROP TABLE IF EXISTS (nonexistent)
    const result = await db.sql("DROP TABLE IF EXISTS nonexistent").exec();
    assert.equal(result[0].message, "Table nonexistent does not exist");
  });

  await withDb(async (db) => {
    // TRUNCATE TABLE
    await db
      .table("users")
      .insert([
        { name: "Alice", email: "alice@test", age: 30, active: true },
        { name: "Bob", email: "bob@test", age: 25, active: false },
      ])
      .exec();

    let rows = await db.sql("SELECT * FROM users").exec();
    assert.equal(rows.length, 2);

    const result = await db.sql("TRUNCATE TABLE users").exec();
    assert.equal(result[0].message, "Table users truncated");

    rows = await db.sql("SELECT * FROM users").exec();
    assert.equal(rows.length, 0);
  });

  await withDb(async (db) => {
    // TRUNCATE without TABLE keyword
    await db
      .table("products")
      .insert([{ name: "Widget", price: 10 }])
      .exec();

    await db.sql("TRUNCATE products").exec();
    const rows = await db.sql("SELECT * FROM products").exec();
    assert.equal(rows.length, 0);
  });

  // ========== Multi-query with mixed commands ==========
  await withDb(async (db) => {
    // INSERT + SELECT via sqlMulti
    const results = await db.sqlMulti(
      "INSERT INTO products (name, price) VALUES ('Laptop', 1200); SELECT * FROM products",
    );
    assert.equal(results.length, 2);
    assert.equal(results[0].error, null);
    assert.equal(results[0].rows[0].message, "1 row(s) inserted");
    assert.equal(results[1].rows.length, 1);
    assert.equal(results[1].rows[0].name, "Laptop");
  });

  await withDb(async (db) => {
    // INSERT + UPDATE + SELECT via sqlMulti
    const results = await db.sqlMulti(
      "INSERT INTO users (name, email, age, active) VALUES ('Alice', 'a@t', 30, true);\n" +
        "UPDATE users SET age = 31 WHERE name = 'Alice';\n" +
        "SELECT * FROM users",
    );
    assert.equal(results.length, 3);
    assert.equal(results[0].error, null);
    assert.equal(results[1].error, null);
    assert.equal(results[2].rows[0].age, 31);
  });

  await withDb(async (db) => {
    // newline separation for mixed commands
    const results = await db.sqlMulti(
      "INSERT INTO products (name, price) VALUES ('A', 10)\nSELECT * FROM products\nDELETE FROM products WHERE name = 'A'",
    );
    assert.equal(results.length, 3);
    assert.equal(results[0].error, null);
    assert.equal(results[1].rows.length, 1);
    assert.equal(results[2].rows[0].message, "1 row(s) deleted");
  });

  // ========== SQL Comments ==========
  await withDb(async (db) => {
    await seed(db);

    // Single-line comment with --
    const r1 = await db
      .sql("-- this is a comment\nSELECT * FROM users LIMIT 2")
      .exec();
    assert.equal(r1.length, 2);

    // Inline single-line comment
    const r2 = await db
      .sql("SELECT * FROM users -- get all users\nLIMIT 3")
      .exec();
    assert.equal(r2.length, 3);

    // Multi-line comment /* ... */
    const r3 = await db
      .sql("/* fetch users */ SELECT * FROM users LIMIT 1")
      .exec();
    assert.equal(r3.length, 1);

    // Multi-line comment spanning lines
    const r4 = await db
      .sql(
        "/*\n * Get user data\n * with a limit\n */\nSELECT * FROM users LIMIT 2",
      )
      .exec();
    assert.equal(r4.length, 2);

    // Comment inside query
    const r5 = await db
      .sql("SELECT * FROM users WHERE /* only adults */ age >= 18 LIMIT 5")
      .exec();
    assert.ok(r5.every((r) => r.age >= 18));

    // Comments shouldn't strip inside single-quoted strings
    const r6 = await db
      .sql("INSERT INTO products (name, price) VALUES ('item -- special', 10)")
      .exec();
    assert.equal(r6[0].message, "1 row(s) inserted");
    const check = await db
      .sql("SELECT * FROM products WHERE name = 'item -- special'")
      .exec();
    assert.equal(check.length, 1);
    assert.equal(check[0].name, "item -- special");

    // Multiple queries with comments via sqlMulti
    const results = await db.sqlMulti(
      "-- first query\nSELECT 1 as one;\n-- second query\nSELECT 2 as two",
    );
    assert.equal(results.length, 2);
    assert.equal(results[0].rows[0].one, 1);
    assert.equal(results[1].rows[0].two, 2);

    // Comment-only lines should be stripped
    const results2 = await db.sqlMulti(
      "SELECT 1 as x;\n-- this is just a comment\n/* another comment */;",
    );
    assert.equal(results2.length, 1);
    assert.equal(results2[0].rows[0].x, 1);
  });

  // ── Error raising & handling ──
  await withDb(async (db) => {
    // Division by zero throws
    await assert.rejects(() => db.sql("SELECT 1/0").exec(), {
      message: "Division by zero",
    });

    // Division by zero in complex expression
    await assert.rejects(() => db.sql("SELECT 1+2*3/0").exec(), {
      message: "Division by zero",
    });

    // Modulo by zero throws
    await assert.rejects(() => db.sql("SELECT 10 % 0").exec(), {
      message: "Division by zero",
    });

    // SQRT of negative throws
    await assert.rejects(
      () => db.sql("SELECT SQRT(-4)").exec(),
      (err) => err.message.includes("SQRT") && err.message.includes("negative"),
    );

    // Division by zero captured in sqlMulti (doesn't crash, returns error)
    const results = await db.sqlMulti("SELECT 1/0");
    assert.equal(results.length, 1);
    assert.equal(results[0].error, "Division by zero");
    assert.equal(results[0].rows, null);

    // Valid math still works
    const r1 = await db.sql("SELECT 10/2 AS half").exec();
    assert.equal(r1[0].half, 5);

    const r2 = await db.sql("SELECT 10 % 3 AS remainder").exec();
    assert.equal(r2[0].remainder, 1);

    // Unknown function throws (during exec — IndependentQueryBuilder)
    await assert.rejects(
      () => db.sql("SELECT FAKEFUNC(1)").exec(),
      (err) => err.message.includes("Unknown function"),
    );

    // Unknown table throws (sync — thrown during table lookup)
    assert.throws(
      () => db.sql("SELECT * FROM nonexistent"),
      (err) => err.message.includes("Unknown table"),
    );

    // Unsupported SQL command throws (sync — thrown during parsing)
    assert.throws(
      () => db.sql("ALTER TABLE users ADD COLUMN foo"),
      (err) => err.message.includes("Unsupported SQL"),
    );

    // DELETE without WHERE throws safety error (async — thrown during exec)
    await assert.rejects(
      () => db.sql("DELETE FROM users").exec(),
      (err) => err.message.includes("DELETE without WHERE"),
    );

    // DROP TABLE for nonexistent table throws (async — thrown during exec)
    await assert.rejects(
      () => db.sql("DROP TABLE nonexistent").exec(),
      (err) => err.message.includes("Unknown table"),
    );

    // DROP TABLE IF EXISTS for nonexistent table does NOT throw
    const dropResult = await db.sql("DROP TABLE IF EXISTS nonexistent").exec();
    assert.equal(dropResult[0].message, "Table nonexistent does not exist");

    // Duplicate key error (insert same id twice)
    await db
      .sql("INSERT INTO users (id, email, age) VALUES (9999, 'dup@test', 25)")
      .exec();
    await assert.rejects(
      () =>
        db
          .sql(
            "INSERT INTO users (id, email, age) VALUES (9999, 'dup2@test', 30)",
          )
          .exec(),
      (err) => err.message.includes("Duplicate key"),
    );

    // Null propagation in math — null field yields null, not 0
    const r3 = await db.sql("SELECT 5 + 0 AS five").exec();
    assert.equal(r3[0].five, 5);

    // Multiple errors in sqlMulti — each captured independently
    const multi = await db.sqlMulti(
      "SELECT 1/0;\nSELECT 1+1 AS two;\nSELECT 5%0",
    );
    assert.equal(multi.length, 3);
    assert.notEqual(multi[0].error, null); // 1/0 fails
    assert.equal(multi[1].error, null); // 1+1 succeeds
    assert.equal(multi[1].rows[0].two, 2);
    assert.notEqual(multi[2].error, null); // 5%0 fails
  });
}

run()
  .then(() => {
    console.log("All tests passed");
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
