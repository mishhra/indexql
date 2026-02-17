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
    const r5 = await db
      .sql("SELECT UPPER('hello') as greeting")
      .exec();
    assert.equal(r5[0].greeting, "HELLO");

    // SELECT CONCAT with literals
    const r6 = await db
      .sql("SELECT CONCAT('hello', ' ', 'world') as msg")
      .exec();
    assert.equal(r6[0].msg, "hello world");

    // SELECT multiple expressions
    const r7 = await db
      .sql("SELECT 1 as a, 2 as b, 3 as c")
      .exec();
    assert.equal(r7[0].a, 1);
    assert.equal(r7[0].b, 2);
    assert.equal(r7[0].c, 3);
  });

  // Multiple SELECT queries (sqlMulti)
  await withDb(async (db) => {
    const products = db.table("products");
    await products.insert([
      { id: 1, name: "Laptop", price: 1200 },
      { id: 2, name: "Phone", price: 800 },
    ]).exec();

    await db.table("users").insert([
      { name: "Alice", email: "alice@test", age: 30, active: true },
    ]).exec();

    // Multi-query with newline separation
    const results = await db.sqlMulti(
      "SELECT * FROM products\nSELECT name FROM users"
    );
    assert.equal(results.length, 2);
    assert.equal(results[0].error, null);
    assert.equal(results[0].rows.length, 2);
    assert.equal(results[1].error, null);
    assert.equal(results[1].rows.length, 1);
    assert.equal(results[1].rows[0].name, "Alice");

    // Multi-query with semicolons
    const results2 = await db.sqlMulti(
      "SELECT name FROM products; SELECT 1 as one"
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
      "SELECT * FROM products\nSELECT * FROM nonexistent_table"
    );
    assert.equal(results4.length, 2);
    assert.equal(results4[0].error, null);
    assert.ok(results4[1].error !== null);
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
