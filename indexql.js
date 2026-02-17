/*
  IndexQL: a small SQL-ish query builder backed by IndexedDB.
  NOTE: localStorage is not ACID; IndexedDB provides transactional guarantees.
*/

class IndexQL {
  constructor(idb, schema) {
    this._db = idb;
    this._schema = schema;
    this.k = KEYWORDS;
    this.fn = {
      ...AGGREGATES,
      ...MATH,
      ...STRING,
    };
  }

  static async open(name, schema) {
    if (!schema || !schema.tables) {
      throw new Error("Schema must include tables");
    }

    const db = await openDatabase(name, schema);
    return new IndexQL(db, schema);
  }

  table(name, tx) {
    if (!this._schema.tables[name]) {
      throw new Error("Unknown table: " + name);
    }
    return new Table(this, name, tx || null);
  }

  sql(query) {
    return parseSql(this, query);
  }

  async sqlMulti(query) {
    return parseAndRunMultiSql(this, query);
  }

  cols(tableName) {
    if (!this._schema.tables[tableName]) {
      throw new Error("Unknown table: " + tableName);
    }
    return createColumnsProxy(tableName, true);
  }

  async populateDummy(options) {
    const config = normalizeDummyOptions(options || {});
    const fetchFn = resolveFetch(config.fetch);
    const resources = resolveDummyResources(config, this._schema.tables);
    if (resources.length === 0) return {};

    // Fetch all data BEFORE opening transaction to avoid transaction timeout
    const dataMap = {};
    for (const resource of resources) {
      const rows = await fetchDummyResource(fetchFn, config.baseUrl, resource);
      dataMap[resource.table] = { resource, rows };
    }

    // Now open transaction and write all data synchronously
    const storeNames = resources.map((resource) => resource.table);
    const tx = this._db.transaction(storeNames, "readwrite");

    try {
      const result = {};
      for (const resource of resources) {
        const store = tx.objectStore(resource.table);
        const { rows } = dataMap[resource.table];
        if (resource.mode === "replace") {
          await promisifyRequest(store.clear());
        }
        const count = await writeRows(store, rows);
        result[resource.name] = count;
      }
      await awaitTxDone(tx);
      return result;
    } catch (err) {
      safeAbort(tx);
      throw err;
    }
  }

  async transaction(storeNames, mode, fn) {
    if (!Array.isArray(storeNames) || storeNames.length === 0) {
      throw new Error("transaction requires storeNames");
    }
    const tx = this._db.transaction(storeNames, mode || "readonly");
    const ctx = new TxContext(this, tx);
    try {
      const result = await fn(ctx);
      await awaitTxDone(tx);
      return result;
    } catch (err) {
      tx.abort();
      throw err;
    }
  }

  close() {
    this._db.close();
  }
}

class TxContext {
  constructor(db, tx) {
    this._db = db;
    this._tx = tx;
    this.k = db.k;
    this.fn = db.fn;
  }

  table(name) {
    return this._db.table(name, this._tx);
  }

  sql(query) {
    return parseSql(this, query);
  }

  async sqlMulti(query) {
    return parseAndRunMultiSql(this, query);
  }

  cols(tableName) {
    return this._db.cols(tableName);
  }
}

class Table {
  constructor(db, name, tx) {
    this._db = db;
    this._name = name;
    this._tx = tx;
  }

  get c() {
    return createColumnsProxy(this._name, false);
  }

  get k() {
    return this._db.k;
  }

  get fn() {
    return this._db.fn;
  }

  cols(tableName) {
    return this._db.cols(tableName);
  }

  select(fields) {
    return new QueryBuilder(this, "select").select(fields);
  }

  insert(data) {
    return new QueryBuilder(this, "insert").insert(data);
  }

  update(data) {
    return new QueryBuilder(this, "update").update(data);
  }

  delete() {
    return new QueryBuilder(this, "delete");
  }
}

class QueryBuilder {
  constructor(table, type) {
    this._table = table;
    this._type = type;
    this._fields = null;
    this._where = [];
    this._whereExpr = null;
    this._having = [];
    this._havingExpr = null;
    this._joins = [];
    this._groupBy = null;
    this._aggregates = null;
    this._orderBy = null;
    this._limit = null;
    this._offset = null;
    this._data = null;
  }

  select(fields) {
    if (fields && !Array.isArray(fields)) {
      throw new Error("select(fields) expects an array");
    }
    this._fields = fields
      ? fields.map((f) => {
          if (f && f.__func) return f; // Don't normalize function objects
          return normalizeField(f);
        })
      : null;
    return this;
  }

  where(field, op, value) {
    if (!field) {
      throw new Error("where(field, op, value) requires a field name");
    }
    this._where.push({
      field: normalizeField(field),
      op: normalizeOperator(op || "="),
      value: normalizeValue(value),
      logic: "and",
    });
    return this;
  }

  orWhere(field, op, value) {
    if (!field) {
      throw new Error("orWhere(field, op, value) requires a field name");
    }
    this._where.push({
      field: normalizeField(field),
      op: normalizeOperator(op || "="),
      value: normalizeValue(value),
      logic: "or",
    });
    return this;
  }

  having(field, op, value) {
    if (!field) {
      throw new Error("having(field, op, value) requires a field name");
    }
    this._having.push({
      field: normalizeField(field),
      op: normalizeOperator(op || "="),
      value: normalizeValue(value),
      logic: "and",
    });
    return this;
  }

  orHaving(field, op, value) {
    if (!field) {
      throw new Error("orHaving(field, op, value) requires a field name");
    }
    this._having.push({
      field: normalizeField(field),
      op: normalizeOperator(op || "="),
      value: normalizeValue(value),
      logic: "or",
    });
    return this;
  }

  join(tableName, leftField, rightField, type) {
    if (!tableName || !leftField || !rightField) {
      throw new Error("join(table, leftField, rightField) requires fields");
    }
    this._joins.push({
      table: tableName,
      leftField: normalizeField(leftField),
      rightField: normalizeField(rightField),
      type: normalizeJoinType(type || "inner"),
    });
    return this;
  }

  groupBy(fields) {
    if (!Array.isArray(fields)) {
      throw new Error("groupBy(fields) expects an array");
    }
    this._groupBy = fields.map(normalizeField);
    return this;
  }

  aggregate(spec) {
    this._aggregates = normalizeAggregates(spec);
    return this;
  }

  orderBy(field, direction) {
    this._orderBy = {
      field: normalizeField(field),
      direction: normalizeDirection(direction || "asc"),
    };
    return this;
  }

  limit(count) {
    this._limit = count;
    return this;
  }

  offset(count) {
    this._offset = count;
    return this;
  }

  insert(data) {
    this._data = data;
    this._type = "insert";
    return this;
  }

  update(data) {
    this._data = data;
    this._type = "update";
    return this;
  }

  async exec() {
    const storeNames = [this._table._name];
    if (this._type === "select") {
      for (const join of this._joins) {
        if (!storeNames.includes(join.table)) {
          storeNames.push(join.table);
        }
      }
    }

    const tx =
      this._table._tx ||
      this._table._db._db.transaction(
        storeNames,
        this._type === "select" ? "readonly" : "readwrite",
      );
    const store = tx.objectStore(this._table._name);
    const whereExpr =
      this._whereExpr || buildExpressionFromClauses(this._where);
    const havingExpr =
      this._havingExpr || buildExpressionFromClauses(this._having);

    try {
      let result;
      if (this._type === "select") {
        result = await runSelect(
          store,
          this._where,
          whereExpr,
          this._joins,
          this._groupBy,
          this._aggregates,
          this._having,
          havingExpr,
          this._orderBy,
          this._limit,
          this._offset,
          this._fields,
          tx,
          this._table._name,
        );
      } else if (this._type === "insert") {
        result = await runInsert(store, this._data);
      } else if (this._type === "update") {
        result = await runUpdate(store, this._where, this._data);
      } else if (this._type === "delete") {
        result = await runDelete(store, this._where);
      } else {
        throw new Error("Unsupported query type: " + this._type);
      }

      if (!this._table._tx) {
        await awaitTxDone(tx);
      }
      return result;
    } catch (err) {
      if (!this._table._tx) {
        safeAbort(tx);
      }
      throw err;
    }
  }
}

async function openDatabase(name, schema) {
  return new Promise((resolve, reject) => {
    const version = schema.version || 1;
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      const existingStores = Array.from(db.objectStoreNames);

      for (const storeName of existingStores) {
        if (!schema.tables[storeName]) {
          db.deleteObjectStore(storeName);
        }
      }

      for (const [tableName, tableDef] of Object.entries(schema.tables)) {
        let store;
        if (!db.objectStoreNames.contains(tableName)) {
          store = db.createObjectStore(tableName, {
            keyPath: tableDef.keyPath || "id",
            autoIncrement: !!tableDef.autoIncrement,
          });
        } else {
          // Check if store options changed (keyPath or autoIncrement) — must recreate
          const existing = req.transaction.objectStore(tableName);
          const wantKey = tableDef.keyPath || "id";
          const wantAuto = !!tableDef.autoIncrement;
          if (existing.keyPath !== wantKey || existing.autoIncrement !== wantAuto) {
            db.deleteObjectStore(tableName);
            store = db.createObjectStore(tableName, {
              keyPath: wantKey,
              autoIncrement: wantAuto,
            });
          } else {
            store = existing;
          }
        }

        const indexDefs = tableDef.indexes || {};
        const existingIndexes = new Set(store.indexNames);
        for (const [indexName, indexDef] of Object.entries(indexDefs)) {
          if (!existingIndexes.has(indexName)) {
            store.createIndex(indexName, indexDef.keyPath || indexName, {
              unique: !!indexDef.unique,
              multiEntry: !!indexDef.multiEntry,
            });
          }
        }
      }
    };

    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
  });
}

function awaitTxDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
  });
}

function safeAbort(tx) {
  try {
    if (tx && tx.readyState === "active") {
      tx.abort();
    }
  } catch (_err) {
    // Ignore abort errors for inactive transactions.
  }
}

function promisifyRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function canUseIndex(where) {
  return where.length === 1 && where[0].op === "=" && where[0].logic !== "or";
}

function createKeyword(value) {
  return { __kw: true, value, toString: () => value };
}

const KEYWORDS = Object.freeze({
  asc: createKeyword("asc"),
  desc: createKeyword("desc"),
  inner: createKeyword("inner"),
  left: createKeyword("left"),
  right: createKeyword("right"),
  and: createKeyword("and"),
  or: createKeyword("or"),
  like: createKeyword("like"),
  between: createKeyword("between"),
  is: createKeyword("is"),
  isNot: createKeyword("is not"),
  not: createKeyword("not"),
  null: createKeyword("null"),
  eq: createKeyword("="),
  ne: createKeyword("!="),
  gt: createKeyword(">"),
  gte: createKeyword(">="),
  lt: createKeyword("<"),
  lte: createKeyword("<="),
  in: createKeyword("in"),
});

function createAgg(op, field) {
  return { __agg: true, op, field };
}

const AGGREGATES = Object.freeze({
  count: (field) => createAgg("count", field || "*"),
  sum: (field) => createAgg("sum", field),
  avg: (field) => createAgg("avg", field),
  min: (field) => createAgg("min", field),
  max: (field) => createAgg("max", field),
});

function createFunc(type, op, ...args) {
  return { __func: true, type, op, args };
}

// Math functions
const MATH = Object.freeze({
  add: (field, value) =>
    createFunc("math", "add", normalizeFieldOrFunc(field), value),
  sub: (field, value) =>
    createFunc("math", "sub", normalizeFieldOrFunc(field), value),
  subtract: (field, value) =>
    createFunc("math", "sub", normalizeFieldOrFunc(field), value),
  mul: (field, value) =>
    createFunc("math", "mul", normalizeFieldOrFunc(field), value),
  multiply: (field, value) =>
    createFunc("math", "mul", normalizeFieldOrFunc(field), value),
  div: (field, value) =>
    createFunc("math", "div", normalizeFieldOrFunc(field), value),
  divide: (field, value) =>
    createFunc("math", "div", normalizeFieldOrFunc(field), value),
  mod: (field, value) =>
    createFunc("math", "mod", normalizeFieldOrFunc(field), value),
  modulo: (field, value) =>
    createFunc("math", "mod", normalizeFieldOrFunc(field), value),
  pow: (field, exponent) =>
    createFunc("math", "pow", normalizeFieldOrFunc(field), exponent),
  abs: (field) => createFunc("math", "abs", normalizeFieldOrFunc(field)),
  ceil: (field) => createFunc("math", "ceil", normalizeFieldOrFunc(field)),
  floor: (field) => createFunc("math", "floor", normalizeFieldOrFunc(field)),
  round: (field, digits) =>
    createFunc("math", "round", normalizeFieldOrFunc(field), digits || 0),
  sqrt: (field) => createFunc("math", "sqrt", normalizeFieldOrFunc(field)),
});

// String functions
const STRING = Object.freeze({
  concat: (...fields) =>
    createFunc("string", "concat", ...fields.map(normalizeFieldOrFunc)),
  trim: (field) => createFunc("string", "trim", normalizeFieldOrFunc(field)),
  trimStart: (field) =>
    createFunc("string", "trimStart", normalizeFieldOrFunc(field)),
  trimLeft: (field) =>
    createFunc("string", "trimStart", normalizeFieldOrFunc(field)),
  trimEnd: (field) =>
    createFunc("string", "trimEnd", normalizeFieldOrFunc(field)),
  trimRight: (field) =>
    createFunc("string", "trimEnd", normalizeFieldOrFunc(field)),
  slice: (field, start, end) =>
    createFunc("string", "slice", normalizeFieldOrFunc(field), start, end),
  substring: (field, start, end) =>
    createFunc("string", "substring", normalizeFieldOrFunc(field), start, end),
  substr: (field, start, length) =>
    createFunc("string", "substr", normalizeFieldOrFunc(field), start, length),
  toUpperCase: (field) =>
    createFunc("string", "toUpperCase", normalizeFieldOrFunc(field)),
  toLowerCase: (field) =>
    createFunc("string", "toLowerCase", normalizeFieldOrFunc(field)),
  replace: (field, search, replaceWith) =>
    createFunc(
      "string",
      "replace",
      normalizeFieldOrFunc(field),
      search,
      replaceWith,
    ),
  replaceAll: (field, search, replaceWith) =>
    createFunc(
      "string",
      "replaceAll",
      normalizeFieldOrFunc(field),
      search,
      replaceWith,
    ),
  split: (field, separator) =>
    createFunc("string", "split", normalizeFieldOrFunc(field), separator),
  startsWith: (field, prefix) =>
    createFunc("string", "startsWith", normalizeFieldOrFunc(field), prefix),
  endsWith: (field, suffix) =>
    createFunc("string", "endsWith", normalizeFieldOrFunc(field), suffix),
  includes: (field, substring) =>
    createFunc("string", "includes", normalizeFieldOrFunc(field), substring),
  indexOf: (field, searchStr) =>
    createFunc("string", "indexOf", normalizeFieldOrFunc(field), searchStr),
  length: (field) =>
    createFunc("string", "length", normalizeFieldOrFunc(field)),
});

function createFieldRef(name) {
  return { __fieldRef: true, name, toString: () => name };
}

function createColumnsProxy(tableName, qualified) {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== "string") return undefined;
        return createFieldRef(qualified ? tableName + "." + prop : prop);
      },
    },
  );
}

function normalizeField(field) {
  if (field && field.__fieldRef) return field.name;
  if (typeof field === "string") return field;
  throw new Error("Field must be a string or column reference");
}

function normalizeFieldOrFunc(field) {
  if (field && field.__func) return field; // Keep function objects as-is
  if (field && field.__fieldRef) return field.name;
  if (typeof field === "string") return field;
  throw new Error("Field must be a string, column reference, or function");
}

function normalizeOperator(op) {
  if (op && op.__kw) return op.value;
  if (typeof op === "string") return op.toLowerCase();
  throw new Error("Operator must be a string or keyword");
}

function normalizeValue(value) {
  if (value && value.__kw && value.value === "null") return null;
  return value;
}

function normalizeDirection(direction) {
  if (direction && direction.__kw) return direction.value;
  if (typeof direction === "string") return direction.toLowerCase();
  throw new Error("Direction must be a string or keyword");
}

function normalizeJoinType(type) {
  if (type && type.__kw) return type.value;
  if (typeof type === "string") return type.toLowerCase();
  throw new Error("Join type must be a string or keyword");
}

function isQualified(field) {
  return field.includes(".");
}

function normalizeAggregates(spec) {
  if (!spec) return null;
  if (Array.isArray(spec)) return spec;
  const out = [];
  for (const [as, value] of Object.entries(spec)) {
    if (typeof value === "string") {
      const parsed = parseAggregateString(value);
      if (!parsed) {
        throw new Error("Invalid aggregate: " + value);
      }
      out.push({ as, op: parsed.op, field: parsed.field });
    } else if (value && value.__agg) {
      out.push({ as, op: value.op, field: normalizeField(value.field) });
    } else if (value && value.op) {
      out.push({ as, op: value.op, field: normalizeField(value.field) });
    }
  }
  return out;
}

function parseAggregateString(value) {
  const match = value.match(/^(count|sum|avg|min|max)\s*\(\s*([^\)]*)\s*\)$/i);
  if (!match) return null;
  return { op: match[1].toLowerCase(), field: match[2] || "*" };
}

function resolveField(row, field) {
  if (!row) return undefined;
  if (field in row) return row[field];

  // Handle nested property access with dot notation, bracket notation, or mixed
  // Examples: "user.name", "data[0].value", "tags[0]", "specs.storage.size"
  if (field && (field.includes(".") || field.includes("["))) {
    // Normalize bracket notation to dot notation: tags[0] => tags.0
    // Also handle mixed: data[0].name => data.0.name
    const normalized = field.replace(/\[(\d+)\]/g, ".$1");

    // For non-qualified nested paths, traverse the object directly
    const parts = normalized.split(".");
    let value = row;
    for (const part of parts) {
      if (value === null || value === undefined) return undefined;
      value = value[part];
    }
    if (value !== undefined) return value;

    // If nested traversal didn't work, try as a qualified field name (table.column)
    const unqualified = stripQualification(field);
    if (unqualified in row) return row[unqualified];
  }

  return undefined;
}

function applyWhere(row, where) {
  if (!where || where.length === 0) return true;
  let result = null;
  for (const clause of where) {
    const matched = matchesClause(row, clause);
    if (result === null) {
      result = matched;
    } else if (clause.logic === "or") {
      result = result || matched;
    } else {
      result = result && matched;
    }
  }
  return result !== null ? result : true;
}

function buildExpressionFromClauses(clauses) {
  if (!clauses || clauses.length === 0) return null;
  let expr = { type: "clause", clause: clauses[0] };
  for (let i = 1; i < clauses.length; i += 1) {
    const clause = clauses[i];
    expr = {
      type: clause.logic === "or" ? "or" : "and",
      left: expr,
      right: { type: "clause", clause },
    };
  }
  return expr;
}

function evaluateExpression(row, expr) {
  if (!expr) return true;
  if (expr.type === "clause") {
    return matchesClause(row, expr.clause);
  }
  if (expr.type === "and") {
    return (
      evaluateExpression(row, expr.left) && evaluateExpression(row, expr.right)
    );
  }
  if (expr.type === "or") {
    return (
      evaluateExpression(row, expr.left) || evaluateExpression(row, expr.right)
    );
  }
  return true;
}

function matchesClause(row, clause) {
  const left =
    clause.field && clause.field.__func
      ? evaluateFunc(row, clause.field)
      : resolveField(row, clause.field);
  const op = clause.op;
  const right =
    clause.value && clause.value.__func
      ? evaluateFunc(row, clause.value)
      : clause.value;

  if (op === "=") return left === right;
  if (op === "!=") return left !== right;
  if (op === ">") return left > right;
  if (op === ">=") return left >= right;
  if (op === "<") return left < right;
  if (op === "<=") return left <= right;
  if (op === "in") return Array.isArray(right) && right.includes(left);
  if (op === "between") {
    if (!Array.isArray(right) || right.length < 2) return false;
    return left >= right[0] && left <= right[1];
  }
  if (op === "like") {
    if (typeof right !== "string") return false;
    const regex = likeToRegex(right);
    return regex.test(String(left));
  }
  if (op === "is") return right == null ? left == null : left === right;
  if (op === "is not") return right == null ? left != null : left !== right;
  return false;
}

function likeToRegex(pattern) {
  const escaped = pattern.replace(/[-/\\^$+?.()|[\]{}]/g, "\\$&");
  const regexText = "^" + escaped.replace(/%/g, ".*").replace(/_/g, ".") + "$";
  return new RegExp(regexText);
}

function projectFields(row, fields) {
  if (!fields) return row;
  const out = {};
  for (const fieldOrFunc of fields) {
    if (typeof fieldOrFunc === "object" && fieldOrFunc.__func) {
      // Use alias if provided, otherwise serialize the function
      const key = fieldOrFunc.__alias || serializeFunc(fieldOrFunc);
      out[key] = evaluateFunc(row, fieldOrFunc);
    } else {
      const key = fieldOrFunc;
      out[key] = resolveField(row, key);
    }
  }
  return out;
}

function serializeFunc(func) {
  const serializeArg = (arg) => {
    if (arg && arg.__func) return serializeFunc(arg);
    if (typeof arg === "string") return arg;
    if (arg === undefined || arg === null) return "";
    return String(arg);
  };

  if (func.type === "math") {
    const infixMap = { add: "+", sub: "-", mul: "*", div: "/", mod: "%" };
    const sym = infixMap[func.op];
    if (sym && func.args.length === 2) {
      return (
        serializeArg(func.args[0]) +
        " " +
        sym +
        " " +
        serializeArg(func.args[1])
      );
    }
    return func.op + "(" + func.args.map(serializeArg).join(", ") + ")";
  }

  if (func.type === "string") {
    return func.op + "(" + func.args.map(serializeArg).join(", ") + ")";
  }

  return JSON.stringify(func);
}

function evaluateFunc(row, func) {
  if (func.type === "math") {
    return evaluateMathFunc(row, func);
  } else if (func.type === "string") {
    return evaluateStringFunc(row, func);
  }
  throw new Error("Unknown function type: " + func.type);
}

function evaluateMathFunc(row, func) {
  const { op, args } = func;
  let value = args[0];

  // If the argument is a function, evaluate it first
  if (value && value.__func) {
    value = evaluateFunc(row, value);
  } else if (typeof value === "number") {
    // Already a numeric literal, use as-is
  } else {
    const resolved = resolveField(row, value);
    // If field not found, try as a numeric literal
    value = resolved !== undefined ? resolved : Number(value);
  }

  if (value === undefined || value === null) return null;
  const num = Number(value);
  if (isNaN(num)) return null;

  // Resolve the second argument (could be a nested func, field, or literal)
  const resolveRight = (arg) => {
    if (arg && arg.__func) {
      const val = evaluateFunc(row, arg);
      if (val === null || val === undefined) return null;
      const n = Number(val);
      return isNaN(n) ? null : n;
    }
    if (typeof arg === "number") return arg;
    const resolved = resolveField(row, arg);
    const raw = resolved !== undefined ? resolved : arg;
    if (raw === null || raw === undefined) return null;
    const n = Number(raw);
    return isNaN(n) ? null : n;
  };

  switch (op) {
    case "add": {
      const r = resolveRight(args[1]);
      return r === null ? null : num + r;
    }
    case "sub": {
      const r = resolveRight(args[1]);
      return r === null ? null : num - r;
    }
    case "mul": {
      const r = resolveRight(args[1]);
      return r === null ? null : num * r;
    }
    case "div": {
      const d = resolveRight(args[1]);
      if (d === null) return null;
      if (d === 0) throw new Error("Division by zero");
      return num / d;
    }
    case "mod": {
      const d = resolveRight(args[1]);
      if (d === null) return null;
      if (d === 0) throw new Error("Division by zero");
      return num % d;
    }
    case "pow": {
      const r = resolveRight(args[1]);
      if (r === null) return null;
      const result = Math.pow(num, r);
      return isNaN(result) || !isFinite(result) ? null : result;
    }
    case "abs":
      return Math.abs(num);
    case "ceil":
      return Math.ceil(num);
    case "floor":
      return Math.floor(num);
    case "round": {
      const digits = args[1] !== undefined ? Number(args[1]) : 0;
      const factor = Math.pow(10, digits);
      return Math.round(num * factor) / factor;
    }
    case "sqrt": {
      if (num < 0) throw new Error("Invalid argument for SQRT: negative value");
      return Math.sqrt(num);
    }
    default:
      return null;
  }
}

function evaluateStringFunc(row, func) {
  const { op, args } = func;

  const resolveArg = (arg) => {
    if (arg && arg.__func) {
      return evaluateFunc(row, arg);
    }
    // Try to resolve as a field first, if it doesn't exist treat as literal
    const resolved = resolveField(row, arg);
    if (resolved !== undefined) return resolved;
    // If it's not a field, treat it as a literal string value
    return typeof arg === "string" ? arg : resolved;
  };

  switch (op) {
    case "concat": {
      const values = args.map((arg) => {
        const v = resolveArg(arg);
        return v === null || v === undefined ? "" : String(v);
      });
      return values.join("");
    }
    case "trim": {
      const str = resolveArg(args[0]);
      return str === null || str === undefined ? undefined : String(str).trim();
    }
    case "trimStart": {
      const str = resolveArg(args[0]);
      return str === null || str === undefined
        ? undefined
        : String(str).trimStart();
    }
    case "trimEnd": {
      const str = resolveArg(args[0]);
      return str === null || str === undefined
        ? undefined
        : String(str).trimEnd();
    }
    case "slice": {
      const str = resolveArg(args[0]);
      if (str === null || str === undefined) return undefined;
      return String(str).slice(args[1], args[2]);
    }
    case "substring": {
      const str = resolveArg(args[0]);
      if (str === null || str === undefined) return undefined;
      return String(str).substring(args[1], args[2]);
    }
    case "substr": {
      const str = resolveArg(args[0]);
      if (str === null || str === undefined) return undefined;
      return String(str).substr(args[1], args[2]);
    }
    case "toUpperCase": {
      const str = resolveArg(args[0]);
      return str === null || str === undefined
        ? undefined
        : String(str).toUpperCase();
    }
    case "toLowerCase": {
      const str = resolveArg(args[0]);
      return str === null || str === undefined
        ? undefined
        : String(str).toLowerCase();
    }
    case "replace": {
      const str = resolveArg(args[0]);
      if (str === null || str === undefined) return undefined;
      return String(str).replace(args[1], args[2]);
    }
    case "replaceAll": {
      const str = resolveArg(args[0]);
      if (str === null || str === undefined) return undefined;
      try {
        const searchRegex = new RegExp(args[1], "g");
        return String(str).replace(searchRegex, args[2]);
      } catch (e) {
        throw new Error("REPLACE: invalid pattern '" + args[1] + "'");
      }
    }
    case "split": {
      const str = resolveArg(args[0]);
      if (str === null || str === undefined) return undefined;
      return String(str).split(args[1]);
    }
    case "startsWith": {
      const str = resolveArg(args[0]);
      return str === null || str === undefined
        ? false
        : String(str).startsWith(args[1]);
    }
    case "endsWith": {
      const str = resolveArg(args[0]);
      return str === null || str === undefined
        ? false
        : String(str).endsWith(args[1]);
    }
    case "includes": {
      const str = resolveArg(args[0]);
      return str === null || str === undefined
        ? false
        : String(str).includes(args[1]);
    }
    case "indexOf": {
      const str = resolveArg(args[0]);
      return str === null || str === undefined
        ? -1
        : String(str).indexOf(args[1]);
    }
    case "length": {
      const str = resolveArg(args[0]);
      return str === null || str === undefined ? 0 : String(str).length;
    }
    default:
      return undefined;
  }
}

async function runSelect(
  store,
  where,
  whereExpr,
  joins,
  groupBy,
  aggregates,
  having,
  havingExpr,
  orderBy,
  limit,
  offset,
  fields,
  tx,
  baseTableName,
) {
  let rows = [];
  const hasJoins = joins && joins.length > 0;
  const baseWhere =
    hasJoins && where
      ? where.filter((clause) => !isQualified(clause.field))
      : where;
  const canPrefilter =
    !hasJoins || (baseWhere && baseWhere.length === where.length);

  const indexableClause =
    !whereExpr && canPrefilter && baseWhere && canUseIndex(baseWhere)
      ? baseWhere[0]
      : null;

  if (indexableClause) {
    const clause = indexableClause;
    const indexNames = Array.from(store.indexNames);
    if (indexNames.includes(clause.field)) {
      const index = store.index(clause.field);
      const match = await promisifyRequest(
        index.getAll(IDBKeyRange.only(clause.value)),
      );
      rows = match.slice();
    } else {
      rows = await cursorCollect(store);
    }
  } else {
    rows = await cursorCollect(store);
  }

  rows = rows.map((row) => addQualifiedFields(row, baseTableName, true));

  if (hasJoins) {
    rows = await applyJoins(rows, joins, tx);
  }

  if (whereExpr) {
    rows = rows.filter((row) => evaluateExpression(row, whereExpr));
  } else if (where && where.length > 0) {
    rows = rows.filter((row) => applyWhere(row, where));
  }

  if (
    (groupBy && groupBy.length > 0) ||
    (aggregates && aggregates.length > 0)
  ) {
    rows = aggregateRows(rows, groupBy || [], aggregates || []);
  }

  if (havingExpr) {
    rows = rows.filter((row) => evaluateExpression(row, havingExpr));
  } else if (having && having.length > 0) {
    rows = rows.filter((row) => applyWhere(row, having));
  }

  if (orderBy && orderBy.field) {
    const dir = orderBy.direction === "desc" ? -1 : 1;
    rows.sort((a, b) => {
      const left = resolveField(a, orderBy.field);
      const right = resolveField(b, orderBy.field);
      if (left < right) return -1 * dir;
      if (left > right) return 1 * dir;
      return 0;
    });
  }

  if (offset) {
    rows = rows.slice(offset);
  }

  if (limit != null) {
    rows = rows.slice(0, limit);
  }

  rows = rows.map((row) => projectFields(row, fields));

  // If there are no joins, remove qualified field duplicates from the final result
  if (!hasJoins) {
    const tableNames = new Set([
      "users",
      "orders",
      "products",
      "posts",
      "todos",
      baseTableName,
    ]);
    rows = rows.map((row) => {
      const out = {};
      for (const [key, value] of Object.entries(row)) {
        // Only skip if it's a qualified field (table.column), not a nested property (obj.prop)
        if (key.includes(".")) {
          const firstPart = key.split(".")[0];
          if (tableNames.has(firstPart)) {
            // This is a qualified field, skip it
            continue;
          }
        }
        out[key] = value;
      }
      return out;
    });
  }

  return rows;
}

function addQualifiedFields(row, tableName, includeUnqualified) {
  const out = {};
  if (includeUnqualified) {
    Object.assign(out, row);
  }
  for (const [key, value] of Object.entries(row)) {
    out[tableName + "." + key] = value;
  }
  return out;
}

function stripQualification(field) {
  if (!field) return field;
  const index = field.indexOf(".");
  return index === -1 ? field : field.slice(index + 1);
}

function normalizeJsonOperators(field) {
  if (!field) return field;
  // Convert PostgreSQL-style arrow operators to dot notation
  // data->'key' -> data.key
  // data->>'key' -> data.key
  // data->[0] -> data[0]
  return field
    .replace(/->>'([^']+)'/g, ".$1") // ->>''key'' -> .key
    .replace(/->'([^']+)'/g, ".$1") // ->'key' -> .key
    .replace(/->(\d+)/g, "[$1]") // ->[0] -> [0]
    .replace(/\[(\d+)\]/g, ".$1"); // [0] -> .0
}

async function applyJoins(rows, joins, tx) {
  let current = rows;
  for (const join of joins) {
    if (join.type === "right") {
      current = await applyRightJoin(current, join, tx);
    } else {
      current = await applyLeftJoin(current, join, tx);
    }
  }
  return current;
}

async function applyLeftJoin(rows, join, tx) {
  const next = [];
  const store = tx.objectStore(join.table);
  for (const row of rows) {
    const leftValue = resolveField(row, join.leftField);
    const joinField = stripQualification(join.rightField);
    const matches = await collectJoinMatches(store, joinField, leftValue);
    if (matches.length === 0) {
      if (join.type === "left") {
        next.push(Object.assign({}, row));
      }
      continue;
    }
    for (const match of matches) {
      const merged = Object.assign(
        {},
        row,
        addQualifiedFields(match, join.table, false),
      );
      next.push(merged);
    }
  }
  return next;
}

async function applyRightJoin(rows, join, tx) {
  const store = tx.objectStore(join.table);
  const rightRows = await cursorCollect(store);
  const leftField = join.leftField;
  const rightField = stripQualification(join.rightField);

  const leftMap = new Map();
  for (const row of rows) {
    const value = resolveField(row, leftField);
    if (!leftMap.has(value)) {
      leftMap.set(value, []);
    }
    leftMap.get(value).push(row);
  }

  const next = [];
  for (const rightRow of rightRows) {
    const rightValue = rightRow[rightField];
    const leftRows = leftMap.get(rightValue);
    if (!leftRows || leftRows.length === 0) {
      next.push(addQualifiedFields(rightRow, join.table, false));
      continue;
    }
    for (const leftRow of leftRows) {
      const merged = Object.assign(
        {},
        leftRow,
        addQualifiedFields(rightRow, join.table, false),
      );
      next.push(merged);
    }
  }

  return next;
}

async function collectJoinMatches(store, field, value) {
  const indexNames = Array.from(store.indexNames);
  if (indexNames.includes(field)) {
    const index = store.index(field);
    return promisifyRequest(index.getAll(IDBKeyRange.only(value)));
  }
  const rows = await cursorCollect(store);
  return rows.filter((row) => row[field] === value);
}

function aggregateRows(rows, groupBy, aggregates) {
  if (!aggregates || aggregates.length === 0) {
    if (!groupBy || groupBy.length === 0) return rows;
    const grouped = new Map();
    for (const row of rows) {
      const key = groupBy
        .map((field) => String(resolveField(row, field)))
        .join("|");
      if (!grouped.has(key)) {
        const out = {};
        for (const field of groupBy) {
          out[field] = resolveField(row, field);
        }
        grouped.set(key, out);
      }
    }
    return Array.from(grouped.values());
  }

  const grouped = new Map();
  const groupKeys = groupBy || [];

  for (const row of rows) {
    const keyParts = groupKeys.map((field) => String(resolveField(row, field)));
    const key = keyParts.join("|");
    if (!grouped.has(key)) {
      grouped.set(key, { rows: [], sample: row });
    }
    grouped.get(key).rows.push(row);
  }

  const results = [];
  for (const group of grouped.values()) {
    const out = {};
    for (const field of groupKeys) {
      out[field] = resolveField(group.sample, field);
    }
    for (const agg of aggregates) {
      out[agg.as] = computeAggregate(agg, group.rows);
    }
    results.push(out);
  }

  return results;
}

function computeAggregate(agg, rows) {
  const op = agg.op;
  const field = agg.field;

  if (op === "count") {
    if (field === "*" || !field) return rows.length;
    return rows.filter((row) => resolveField(row, field) != null).length;
  }

  const values = rows
    .map((row) => resolveField(row, field))
    .filter((value) => value != null);

  if (values.length === 0) return null;
  if (op === "sum" || op === "avg") {
    const total = values.reduce((acc, value) => acc + Number(value || 0), 0);
    return op === "avg" ? total / values.length : total;
  }
  if (op === "min") {
    return values.reduce(
      (min, value) => (value < min ? value : min),
      values[0],
    );
  }
  if (op === "max") {
    return values.reduce(
      (max, value) => (value > max ? value : max),
      values[0],
    );
  }
  return null;
}

function cursorCollect(store) {
  return new Promise((resolve, reject) => {
    const rows = [];
    const req = store.openCursor();
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        rows.push(cursor.value);
        cursor.continue();
      } else {
        resolve(rows);
      }
    };
  });
}

async function runInsert(store, data) {
  if (!data) throw new Error("insert(data) requires data");
  if (Array.isArray(data)) {
    const ids = [];
    for (const row of data) {
      const id = await promisifyRequest(store.add(row));
      ids.push(id);
    }
    return ids;
  }
  return promisifyRequest(store.add(data));
}

async function runUpdate(store, where, patch) {
  if (!patch) throw new Error("update(data) requires data");
  const rows = await runSelect(
    store,
    where,
    null,
    [],
    null,
    null,
    [],
    null,
    null,
    null,
    null,
    null,
    store.transaction,
    store.name,
  );
  let count = 0;

  for (const row of rows) {
    const updated = Object.assign({}, row, patch);
    await promisifyRequest(store.put(updated));
    count += 1;
  }

  return count;
}

async function runDelete(store, where) {
  const rows = await runSelect(
    store,
    where,
    null,
    [],
    null,
    null,
    [],
    null,
    null,
    null,
    null,
    null,
    store.transaction,
    store.name,
  );
  let count = 0;

  for (const row of rows) {
    const keyPath = store.keyPath || "id";
    const key = row[keyPath];
    await promisifyRequest(store.delete(key));
    count += 1;
  }

  return count;
}

// Evaluates independent SELECT expressions (no FROM clause)
// e.g. SELECT 1, SELECT 1 + 2, SELECT CONCAT('hello', ' ', 'world')
class IndependentQueryBuilder {
  constructor(selectList) {
    this._selectList = selectList;
  }

  async exec() {
    const items = splitCsv(this._selectList);
    const row = {};
    for (const item of items) {
      const trimmed = item.trim();
      // Check for alias: expr AS alias
      const aliasMatch = trimmed.match(/^(.+?)\s+as\s+([a-zA-Z0-9_]+)$/i);
      const rawExpr = aliasMatch ? aliasMatch[1].trim() : trimmed;
      const alias = aliasMatch ? aliasMatch[2].trim() : null;

      const parsed = parseSqlExpression(rawExpr);
      if (parsed && parsed.__func) {
        const key = alias || serializeFunc(parsed);
        row[key] = evaluateFunc({}, parsed);
      } else {
        // Could be a number literal, string literal, or plain value
        const num = Number(parsed);
        const key = alias || String(parsed);
        if (!isNaN(num) && String(parsed).trim() !== "") {
          row[key] = num;
        } else {
          // Check if it's a quoted string
          const strMatch = String(parsed).match(/^['"](.*)['"]/s);
          if (strMatch) {
            row[key] = strMatch[1];
          } else {
            row[key] = parsed;
          }
        }
      }
    }
    return [row];
  }
}

// Builder for DDL and DML operations parsed from raw SQL
class SqlCommandBuilder {
  constructor(dbOrTx, command, params) {
    this._dbOrTx = dbOrTx;
    this._command = command;
    this._params = params;
  }

  async exec() {
    const db =
      this._dbOrTx instanceof TxContext ? this._dbOrTx._db : this._dbOrTx;
    const p = this._params;

    switch (this._command) {
      case "show_tables": {
        const tables = Object.keys(db._schema.tables).map((t) => ({
          table_name: t,
        }));
        return tables;
      }

      case "show_columns": {
        const tableName = p.table;
        if (!db._schema.tables[tableName]) {
          throw new Error("Unknown table: " + tableName);
        }
        const def = db._schema.tables[tableName];
        const cols = [];
        cols.push({
          column: def.keyPath || "id",
          type: "keyPath",
          autoIncrement: !!def.autoIncrement,
        });
        const indexes = def.indexes || {};
        for (const [name, idx] of Object.entries(indexes)) {
          cols.push({ column: name, type: "index", unique: !!idx.unique });
        }
        return cols;
      }

      case "create_table": {
        const tableName = p.table;
        if (db._schema.tables[tableName]) {
          if (p.ifNotExists) {
            return [{ message: "Table " + tableName + " already exists" }];
          }
          throw new Error("Table " + tableName + " already exists");
        }
        const tableDef = {
          keyPath: p.keyPath || "id",
          autoIncrement: p.autoIncrement !== false,
          indexes: {},
        };
        // Add indexes for any non-keyPath columns
        for (const col of p.columns) {
          if (col.name !== tableDef.keyPath) {
            const indexDef = {};
            if (col.unique) indexDef.unique = true;
            tableDef.indexes[col.name] = indexDef;
          }
        }
        db._schema.tables[tableName] = tableDef;
        // Reopen database with incremented version to apply schema change
        db._db.close();
        const newVersion = (db._db.version || 1) + 1;
        db._schema.version = newVersion;
        db._db = await openDatabase(db._db.name, db._schema);
        return [{ message: "Table " + tableName + " created" }];
      }

      case "drop_table": {
        const tableName = p.table;
        if (!db._schema.tables[tableName]) {
          if (p.ifExists) {
            return [{ message: "Table " + tableName + " does not exist" }];
          }
          throw new Error("Unknown table: " + tableName);
        }
        delete db._schema.tables[tableName];
        db._db.close();
        const newVersion = (db._db.version || 1) + 1;
        db._schema.version = newVersion;
        db._db = await openDatabase(db._db.name, db._schema);
        return [{ message: "Table " + tableName + " dropped" }];
      }

      case "truncate": {
        const tableName = p.table;
        if (!db._schema.tables[tableName]) {
          throw new Error("Unknown table: " + tableName);
        }
        const tx = db._db.transaction([tableName], "readwrite");
        const store = tx.objectStore(tableName);
        await promisifyRequest(store.clear());
        await awaitTxDone(tx);
        return [{ message: "Table " + tableName + " truncated" }];
      }

      case "insert": {
        const tableName = p.table;
        if (!db._schema.tables[tableName]) {
          throw new Error("Unknown table: " + tableName);
        }
        if (!p.rows || p.rows.length === 0) {
          throw new Error("INSERT requires at least one row");
        }
        const tx = db._db.transaction([tableName], "readwrite");
        const store = tx.objectStore(tableName);
        const ids = [];
        try {
          for (const row of p.rows) {
            const id = await promisifyRequest(store.add(row));
            ids.push(id);
          }
          await awaitTxDone(tx);
        } catch (err) {
          if (err.name === "ConstraintError") {
            throw new Error(
              "Duplicate key: a record with that key already exists in " +
                tableName,
            );
          }
          throw err;
        }
        return [{ message: ids.length + " row(s) inserted", ids }];
      }

      case "update": {
        const tableName = p.table;
        if (!db._schema.tables[tableName]) {
          throw new Error("Unknown table: " + tableName);
        }
        if (!p.patch || Object.keys(p.patch).length === 0) {
          throw new Error("UPDATE requires at least one SET assignment");
        }
        const tx = db._db.transaction([tableName], "readwrite");
        const store = tx.objectStore(tableName);
        const whereExpr = p.whereExpr;
        const allRows = await cursorCollect(store);
        let count = 0;
        for (const row of allRows) {
          if (whereExpr && !evaluateExpression(row, whereExpr)) continue;
          const updated = Object.assign({}, row, p.patch);
          await promisifyRequest(store.put(updated));
          count++;
        }
        await awaitTxDone(tx);
        return [{ message: count + " row(s) updated" }];
      }

      case "delete": {
        const tableName = p.table;
        if (!db._schema.tables[tableName]) {
          throw new Error("Unknown table: " + tableName);
        }
        if (!p.whereExpr) {
          throw new Error(
            "DELETE without WHERE would remove all rows. Use TRUNCATE " +
              tableName +
              " instead",
          );
        }
        const tx = db._db.transaction([tableName], "readwrite");
        const store = tx.objectStore(tableName);
        const whereExpr = p.whereExpr;
        const allRows = await cursorCollect(store);
        let count = 0;
        const keyPath = store.keyPath || "id";
        for (const row of allRows) {
          if (!evaluateExpression(row, whereExpr)) continue;
          await promisifyRequest(store.delete(row[keyPath]));
          count++;
        }
        await awaitTxDone(tx);
        return [{ message: count + " row(s) deleted" }];
      }

      default:
        throw new Error("Unknown SQL command: " + this._command);
    }
  }
}

// Split SQL text into multiple queries and run each one
async function parseAndRunMultiSql(dbOrTx, sql) {
  if (!sql || typeof sql !== "string") {
    throw new Error("sqlMulti(query) requires a SQL string");
  }

  const queries = splitSqlQueries(sql);
  const results = [];
  for (const query of queries) {
    try {
      const qb = parseSql(dbOrTx, query);
      const rows = await qb.exec();
      results.push({ query, rows, error: null });
    } catch (err) {
      results.push({ query, rows: null, error: err.message });
    }
  }
  return results;
}

// Strip SQL comments: -- single line and /* multi-line */
function stripSqlComments(sql) {
  let result = "";
  let i = 0;
  let inQuote = null;
  while (i < sql.length) {
    const ch = sql[i];
    // Track quoted strings so we don't strip inside them
    if (inQuote) {
      result += ch;
      if (ch === inQuote) inQuote = null;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inQuote = ch;
      result += ch;
      i++;
      continue;
    }
    // Single-line comment: -- ...
    if (ch === "-" && i + 1 < sql.length && sql[i + 1] === "-") {
      // Skip until end of line
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    // Multi-line comment: /* ... */
    if (ch === "/" && i + 1 < sql.length && sql[i + 1] === "*") {
      i += 2;
      while (
        i < sql.length &&
        !(sql[i] === "*" && i + 1 < sql.length && sql[i + 1] === "/")
      )
        i++;
      i += 2; // skip closing */
      result += " "; // replace comment with space to avoid token merge
      continue;
    }
    result += ch;
    i++;
  }
  return result;
}

// Split a multi-query SQL string into individual queries
// Supports semicolons and newline-separated SQL statements
function splitSqlQueries(sql) {
  const text = stripSqlComments(sql).trim();

  // First split by semicolons
  let parts = text
    .split(/;/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Then split any remaining parts that contain multiple statements on separate lines
  const stmtKeywords =
    /\n(?=\s*(?:select|insert|update|delete|create|drop|truncate|show|alter|describe|explain)\b)/i;
  const queries = [];
  for (const part of parts) {
    const subParts = part
      .split(stmtKeywords)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    queries.push(...subParts);
  }

  return queries;
}

// Parse SQL SET clause: "col1 = val1, col2 = val2" → { col1: val1, col2: val2 }
function parseSetClause(setStr) {
  const result = {};
  // Split carefully on commas not inside quotes/parens
  const assignments = splitCsv(setStr);
  for (const assignment of assignments) {
    const eqIdx = assignment.indexOf("=");
    if (eqIdx === -1) throw new Error("Invalid SET clause: " + assignment);
    const col = assignment.slice(0, eqIdx).trim();
    const valStr = assignment.slice(eqIdx + 1).trim();
    result[col] = parseSqlLiteral(valStr);
  }
  return result;
}

// Parse a SQL literal value: 'string', number, null, true, false, JSON object/array
function parseSqlLiteral(str) {
  const trimmed = str.trim();
  // Quoted string (single or double)
  if (/^'([\s\S]*)'$/.test(trimmed)) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  if (/^"([\s\S]*)"$/.test(trimmed)) {
    return trimmed.slice(1, -1).replace(/""/g, '"');
  }
  // null
  if (/^null$/i.test(trimmed)) return null;
  // boolean
  if (/^true$/i.test(trimmed)) return true;
  if (/^false$/i.test(trimmed)) return false;
  // JSON object or array
  if (
    (trimmed[0] === "{" && trimmed[trimmed.length - 1] === "}") ||
    (trimmed[0] === "[" && trimmed[trimmed.length - 1] === "]")
  ) {
    try {
      // SQL uses single quotes for strings — convert to double quotes for JSON parse
      const jsonStr = trimmed.replace(/'([^']*)'/g, '"$1"');
      return JSON.parse(jsonStr);
    } catch (e) {
      // fallback: try direct parse in case it's already valid JSON
      try {
        return JSON.parse(trimmed);
      } catch (_) {}
    }
  }
  // number
  const num = Number(trimmed);
  if (!isNaN(num) && trimmed !== "") return num;
  // fallback: return as string
  return trimmed;
}

// Parse VALUES rows: "(v1, v2), (v3, v4)" → [{col1: v1, col2: v2}, ...]
// Handles nested JSON objects/arrays inside value tuples
function parseValuesRows(columns, valuesStr) {
  const rows = [];
  const groups = extractValueGroups(valuesStr);
  for (const group of groups) {
    const vals = splitCsv(group);
    if (vals.length !== columns.length) {
      throw new Error(
        "Column count (" +
          columns.length +
          ") doesn't match value count (" +
          vals.length +
          ")",
      );
    }
    const row = {};
    for (let i = 0; i < columns.length; i++) {
      row[columns[i]] = parseSqlLiteral(vals[i]);
    }
    rows.push(row);
  }
  if (rows.length === 0) {
    throw new Error("No values found in INSERT statement");
  }
  return rows;
}

// Extract top-level (...) groups from a VALUES clause, respecting nested {}, [], ()
function extractValueGroups(str) {
  const groups = [];
  let i = 0;
  while (i < str.length) {
    if (str[i] === "(") {
      // Find the matching close paren, respecting nesting and quotes
      let depth = 1;
      let j = i + 1;
      let inQuote = null;
      while (j < str.length && depth > 0) {
        const ch = str[j];
        if (inQuote) {
          if (ch === inQuote) inQuote = null;
        } else if (ch === "'" || ch === '"') {
          inQuote = ch;
        } else if (ch === "(" || ch === "{" || ch === "[") {
          depth++;
        } else if (ch === ")" || ch === "}" || ch === "]") {
          depth--;
        }
        if (depth > 0) j++;
      }
      groups.push(str.slice(i + 1, j).trim());
      i = j + 1;
    } else {
      i++;
    }
  }
  return groups;
}

function parseSql(dbOrTx, sql) {
  if (!sql || typeof sql !== "string") {
    throw new Error("sql(query) requires a SQL string");
  }

  const text = stripSqlComments(sql).trim().replace(/;$/, "");
  const upper = text.toUpperCase();

  // ---- SHOW TABLES ----
  if (/^show\s+tables$/i.test(text)) {
    return new SqlCommandBuilder(dbOrTx, "show_tables", {});
  }

  // ---- SHOW COLUMNS FROM tableName / DESCRIBE tableName ----
  {
    const m = text.match(
      /^(?:show\s+columns\s+from|describe|desc)\s+([a-zA-Z0-9_]+)$/i,
    );
    if (m) {
      return new SqlCommandBuilder(dbOrTx, "show_columns", { table: m[1] });
    }
  }

  // ---- CREATE TABLE ----
  {
    const m = text.match(
      /^create\s+table\s+(if\s+not\s+exists\s+)?([a-zA-Z0-9_]+)\s*\(\s*([\s\S]+)\s*\)$/i,
    );
    if (m) {
      const ifNotExists = !!m[1];
      const tableName = m[2];
      const colDefs = splitCsv(m[3]);
      const columns = [];
      let keyPath = null;
      let autoIncrement = true;
      for (const cd of colDefs) {
        const parts = cd.trim().split(/\s+/);
        const colName = parts[0];
        const rest = cd.toUpperCase();
        const isUnique = /\bUNIQUE\b/.test(rest);
        const isPrimary = /\bPRIMARY\s*KEY\b/.test(rest);
        if (isPrimary) {
          keyPath = colName;
          // If the type looks non-numeric, no autoIncrement
          if (/\b(VARCHAR|TEXT|CHAR)\b/i.test(rest)) {
            autoIncrement = false;
          }
        }
        columns.push({ name: colName, unique: isUnique, primary: isPrimary });
      }
      return new SqlCommandBuilder(dbOrTx, "create_table", {
        table: tableName,
        columns,
        keyPath: keyPath || "id",
        autoIncrement,
        ifNotExists,
      });
    }
  }

  // ---- DROP TABLE ----
  {
    const m = text.match(/^drop\s+table\s+(if\s+exists\s+)?([a-zA-Z0-9_]+)$/i);
    if (m) {
      return new SqlCommandBuilder(dbOrTx, "drop_table", {
        table: m[2],
        ifExists: !!m[1],
      });
    }
  }

  // ---- TRUNCATE TABLE / TRUNCATE ----
  {
    const m = text.match(/^truncate\s+(?:table\s+)?([a-zA-Z0-9_]+)$/i);
    if (m) {
      return new SqlCommandBuilder(dbOrTx, "truncate", { table: m[1] });
    }
  }

  // ---- INSERT INTO ----
  {
    // INSERT INTO table (col1, col2, ...) VALUES (v1, v2, ...), (v3, v4, ...)
    const m = text.match(
      /^insert\s+into\s+([a-zA-Z0-9_]+)\s*\(\s*([\s\S]+?)\s*\)\s*values\s+([\s\S]+)$/i,
    );
    if (m) {
      const tableName = m[1];
      const colList = splitCsv(m[2]).map((c) => c.trim());
      const valuesStr = m[3];
      const rows = parseValuesRows(colList, valuesStr);
      return new SqlCommandBuilder(dbOrTx, "insert", {
        table: tableName,
        rows,
      });
    }

    // INSERT INTO table SET col1 = val1, col2 = val2
    const mSet = text.match(
      /^insert\s+into\s+([a-zA-Z0-9_]+)\s+set\s+([\s\S]+)$/i,
    );
    if (mSet) {
      const tableName = mSet[1];
      const row = parseSetClause(mSet[2]);
      return new SqlCommandBuilder(dbOrTx, "insert", {
        table: tableName,
        rows: [row],
      });
    }
  }

  // ---- UPDATE ----
  {
    const m = text.match(
      /^update\s+([a-zA-Z0-9_]+)\s+set\s+([\s\S]+?)(?:\s+where\s+([\s\S]+))?$/i,
    );
    if (m) {
      const tableName = m[1];
      const patch = parseSetClause(m[2]);
      const whereExpr = m[3] ? parseWhereExpression(m[3]) : null;
      return new SqlCommandBuilder(dbOrTx, "update", {
        table: tableName,
        patch,
        whereExpr,
      });
    }
  }

  // ---- DELETE FROM ----
  {
    const m = text.match(
      /^delete\s+from\s+([a-zA-Z0-9_]+)(?:\s+where\s+([\s\S]+))?$/i,
    );
    if (m) {
      const tableName = m[1];
      const whereExpr = m[2] ? parseWhereExpression(m[2]) : null;
      return new SqlCommandBuilder(dbOrTx, "delete", {
        table: tableName,
        whereExpr,
      });
    }
  }

  // ---- SELECT (existing logic) ----
  // Check for independent SELECT (no FROM clause): SELECT 1, SELECT CONCAT('a','b')
  const independentMatch = text.match(/^select\s+([\s\S]+)$/i);
  if (independentMatch) {
    const hasFrom = /\bfrom\s+[a-zA-Z0-9_]+/i.test(text);
    if (!hasFrom) {
      // Independent select — evaluate expressions without a table
      return new IndependentQueryBuilder(independentMatch[1].trim());
    }
  }

  const match = text.match(/^select\s+([\s\S]+?)\s+from\s+([a-zA-Z0-9_]+)\s*/i);
  if (!match) {
    const keyword = text.split(/\s+/)[0].toUpperCase();
    if (/^SELECT$/i.test(keyword)) {
      throw new Error("Invalid SELECT syntax. Expected: SELECT ... FROM table");
    }
    throw new Error("Unsupported SQL command: " + keyword);
  }

  const selectList = match[1];
  const fromTable = match[2];
  let rest = text.slice(match[0].length);

  // Parse TOP clause from selectList (e.g., "TOP 10 *" -> extracts 10)
  const topMatch = selectList.match(/^top\s+(\d+)\s+(.+)$/i);
  let topCount = null;
  let finalSelectList = selectList;

  if (topMatch) {
    topCount = Number(topMatch[1]);
    finalSelectList = topMatch[2];
  }

  const parsedSelect = parseSelectList(finalSelectList);
  const qb = dbOrTx.table(fromTable).select(parsedSelect.fields);
  if (parsedSelect.aggregates.length > 0) {
    qb.aggregate(parsedSelect.aggregates);
  }

  // Apply TOP limit (TOP takes precedence over LIMIT clause)
  let hasExplicitLimit = false;

  while (/^\s*(left|right|inner)?\s*join\s+/i.test(rest)) {
    const joinMatch = rest.match(
      /^\s*(left|right|inner)?\s*join\s+([a-zA-Z0-9_]+)\s+on\s+([^=<>!\s]+)\s*=\s*([^=<>!\s]+)\s*/i,
    );
    if (!joinMatch) {
      throw new Error("Invalid JOIN clause");
    }
    qb.join(joinMatch[2], joinMatch[3], joinMatch[4], joinMatch[1] || "inner");
    rest = rest.slice(joinMatch[0].length);
  }

  const whereClause = extractClause(rest, "where");
  if (whereClause) {
    qb._whereExpr = parseWhereExpression(whereClause);
    qb._where = [];
  }

  const groupClause = extractClause(rest, "group by");
  if (groupClause) {
    const groupFields = splitCsv(groupClause);
    qb.groupBy(groupFields);
  } else if (
    parsedSelect.groupFields.length > 0 &&
    parsedSelect.aggregates.length > 0
  ) {
    qb.groupBy(parsedSelect.groupFields);
  }

  const havingClause = extractClause(rest, "having");
  if (havingClause) {
    qb._havingExpr = parseWhereExpression(havingClause);
    qb._having = [];
  }

  const orderClause = extractClause(rest, "order by");
  if (orderClause) {
    const parts = orderClause.trim().split(/\s+/);
    qb.orderBy(parts[0], parts[1] || "asc");
  }

  const limitClause = extractClause(rest, "limit");
  if (limitClause && !topCount) {
    qb.limit(Number(limitClause.trim()));
    hasExplicitLimit = true;
  }

  // Apply TOP if it was specified (overrides LIMIT)
  if (topCount) {
    qb.limit(topCount);
  }

  const offsetClause =
    extractClause(rest, "offset") || extractClause(rest, "skip");
  if (offsetClause) {
    qb.offset(Number(offsetClause.trim()));
  }

  return qb;
}

function extractClause(sql, keyword) {
  const lower = sql.toLowerCase();
  const key = keyword.toLowerCase();
  const index = lower.indexOf(key);
  if (index === -1) return null;
  const start = index + key.length;
  const tail = sql.slice(start);
  const nextMatch = tail.match(
    /\b(where|group by|having|order by|limit|offset|skip)\b/i,
  );
  if (!nextMatch) return tail.trim();
  const end = nextMatch.index;
  return tail.slice(0, end).trim();
}

// All SQL function names recognized
const SQL_FUNC_NAMES = new Set([
  // Math
  "add",
  "sub",
  "subtract",
  "mul",
  "multiply",
  "div",
  "divide",
  "mod",
  "modulo",
  "pow",
  "abs",
  "ceil",
  "floor",
  "round",
  "sqrt",
  // String
  "concat",
  "trim",
  "ltrim",
  "rtrim",
  "trim_start",
  "trim_end",
  "slice",
  "substring",
  "substr",
  "upper",
  "lower",
  "replace",
  "replaceall",
  "replace_all",
  "split",
  "starts_with",
  "startswith",
  "ends_with",
  "endswith",
  "includes",
  "contains",
  "indexof",
  "index_of",
  "length",
  "len",
]);

// Map SQL function names to internal op names
const SQL_FUNC_MAP = {
  add: { type: "math", op: "add" },
  sub: { type: "math", op: "sub" },
  subtract: { type: "math", op: "sub" },
  mul: { type: "math", op: "mul" },
  multiply: { type: "math", op: "mul" },
  div: { type: "math", op: "div" },
  divide: { type: "math", op: "div" },
  mod: { type: "math", op: "mod" },
  modulo: { type: "math", op: "mod" },
  pow: { type: "math", op: "pow" },
  abs: { type: "math", op: "abs" },
  ceil: { type: "math", op: "ceil" },
  floor: { type: "math", op: "floor" },
  round: { type: "math", op: "round" },
  sqrt: { type: "math", op: "sqrt" },
  concat: { type: "string", op: "concat" },
  trim: { type: "string", op: "trim" },
  ltrim: { type: "string", op: "trimStart" },
  trim_start: { type: "string", op: "trimStart" },
  rtrim: { type: "string", op: "trimEnd" },
  trim_end: { type: "string", op: "trimEnd" },
  slice: { type: "string", op: "slice" },
  substring: { type: "string", op: "substring" },
  substr: { type: "string", op: "substr" },
  upper: { type: "string", op: "toUpperCase" },
  lower: { type: "string", op: "toLowerCase" },
  replace: { type: "string", op: "replace" },
  replaceall: { type: "string", op: "replaceAll" },
  replace_all: { type: "string", op: "replaceAll" },
  split: { type: "string", op: "split" },
  starts_with: { type: "string", op: "startsWith" },
  startswith: { type: "string", op: "startsWith" },
  ends_with: { type: "string", op: "endsWith" },
  endswith: { type: "string", op: "endsWith" },
  includes: { type: "string", op: "includes" },
  contains: { type: "string", op: "includes" },
  indexof: { type: "string", op: "indexOf" },
  index_of: { type: "string", op: "indexOf" },
  length: { type: "string", op: "length" },
  len: { type: "string", op: "length" },
};

// Parse a SQL expression that may contain functions, math operators, or plain field names
// Returns either a string (field name) or a __func object
function parseSqlExpression(expr) {
  const trimmed = expr.trim();

  // Check for function call: funcName(...)
  const funcCallMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*\((.*)\)$/);
  if (funcCallMatch) {
    const funcName = funcCallMatch[1].toLowerCase();
    const argsText = funcCallMatch[2];

    // Skip aggregate functions — they're handled separately
    if (["count", "sum", "avg", "min", "max"].includes(funcName)) {
      return null; // Signal that this is an aggregate, not a scalar function
    }

    const mapping = SQL_FUNC_MAP[funcName];
    if (!mapping) {
      throw new Error("Unknown function: " + funcName);
    }

    const args = splitCsv(argsText).map((arg) => {
      const a = arg.trim();
      // Check if it's a string literal
      const strMatch = a.match(/^['"](.*)['"]/s);
      if (strMatch) return strMatch[1];
      // Check if it's a number literal
      const num = Number(a);
      if (!isNaN(num) && a !== "") return num;
      // Recursively parse (could be a nested function)
      const nested = parseSqlExpression(a);
      return nested;
    });

    return { __func: true, type: mapping.type, op: mapping.op, args };
  }

  // Check for inline math expressions: field + value, field - value, field * value, field / value, field % value
  // Also supports literal numbers on either side: 1 + 2, 3.5 * 2
  const mathMatch = trimmed.match(
    /^([a-zA-Z_][a-zA-Z0-9_.\[\]]*|[0-9]+(?:\.[0-9]+)?)\s*([+\-*\/%])\s*(.+)$/,
  );
  if (mathMatch) {
    const field = mathMatch[1].trim();
    const operator = mathMatch[2];
    const rightExpr = mathMatch[3].trim();
    const opMap = {
      "+": "add",
      "-": "sub",
      "*": "mul",
      "/": "div",
      "%": "mod",
    };
    const rightVal = Number(rightExpr);
    const right = isNaN(rightVal) ? parseSqlExpression(rightExpr) : rightVal;
    const leftVal = Number(field);
    const left = !isNaN(leftVal) && field !== "" ? leftVal : field;
    return {
      __func: true,
      type: "math",
      op: opMap[operator],
      args: [left, right],
    };
  }

  // Plain field name
  return trimmed;
}

function parseSelectList(selectList) {
  const items = splitCsv(selectList);
  const fields = [];
  const aggregates = [];
  const groupFields = [];
  let selectAll = false;

  for (const item of items) {
    const trimmed = item.trim();
    if (trimmed === "*") {
      selectAll = true;
      continue;
    }

    const aliasMatch = trimmed.match(/^(.+?)\s+as\s+([a-zA-Z0-9_]+)$/i);
    const rawExpr = aliasMatch ? aliasMatch[1].trim() : trimmed;
    const alias = aliasMatch ? aliasMatch[2].trim() : null;

    // Try aggregate first
    const aggMatch = rawExpr.match(/^(count|sum|avg|min|max)\s*\(([^\)]*)\)$/i);
    if (aggMatch) {
      const op = aggMatch[1].toLowerCase();
      const field = aggMatch[2].trim() || "*";
      const autoName =
        field === "*" ? op : op + "_" + field.replace(/\W+/g, "_");
      aggregates.push({ as: alias || autoName, op, field });
      continue;
    }

    // Try scalar function or math expression
    const parsed = parseSqlExpression(rawExpr);
    if (parsed && parsed.__func) {
      // If alias is given, attach it so we can use it as the output key
      if (alias) parsed.__alias = alias;
      fields.push(parsed);
    } else {
      fields.push(rawExpr);
      groupFields.push(rawExpr);
    }
  }

  return {
    fields: selectAll || fields.length === 0 ? null : fields,
    aggregates,
    groupFields,
  };
}

function parseWhereExpression(whereClause) {
  const tokens = tokenizeWhere(whereClause);
  let index = 0;

  function peek() {
    return tokens[index];
  }

  function consume() {
    return tokens[index++];
  }

  function matchKeyword(value) {
    const token = peek();
    if (token && token.type === "word" && token.value.toLowerCase() === value) {
      index += 1;
      return true;
    }
    return false;
  }

  function expect(type, value) {
    const token = consume();
    if (!token || token.type !== type || (value && token.value !== value)) {
      throw new Error(
        "Invalid WHERE clause near: " + (token ? token.value : "end"),
      );
    }
    return token;
  }

  function parseExpression() {
    return parseOr();
  }

  function parseOr() {
    let left = parseAnd();
    while (matchKeyword("or")) {
      const right = parseAnd();
      left = { type: "or", left, right };
    }
    return left;
  }

  function parseAnd() {
    let left = parseTerm();
    while (matchKeyword("and")) {
      const right = parseTerm();
      left = { type: "and", left, right };
    }
    return left;
  }

  function parseTerm() {
    const token = peek();
    if (token && token.type === "lparen") {
      consume();
      const expr = parseExpression();
      expect("rparen");
      return expr;
    }
    return { type: "clause", clause: parsePredicate() };
  }

  function parsePredicate() {
    // Check if the field starts a function call like UPPER(name), CONCAT(a, b), etc.
    const fieldToken = peek();
    let field;
    if (
      fieldToken &&
      fieldToken.type === "word" &&
      SQL_FUNC_NAMES.has(fieldToken.value.toLowerCase())
    ) {
      // Collect the full function call text by scanning tokens through matching parens
      field = collectFuncExpression();
    } else {
      const ft = expect("word");
      field = normalizeJsonOperators(ft.value);
    }

    if (typeof field === "string") {
      // Check for inline math: field + 5, field * 0.9, etc.
      const opTok = peek();
      if (
        opTok &&
        opTok.type === "op" &&
        ["+", "-", "*", "/", "%"].includes(opTok.value)
      ) {
        consume(); // consume math operator
        const rightTok = expectValue();
        const rightVal = parseValueToken(rightTok);
        const mathOpMap = {
          "+": "add",
          "-": "sub",
          "*": "mul",
          "/": "div",
          "%": "mod",
        };
        field = {
          __func: true,
          type: "math",
          op: mathOpMap[opTok.value],
          args: [field, rightVal],
        };
      }
    }

    if (matchKeyword("is")) {
      if (matchKeyword("not")) {
        if (matchKeyword("null")) {
          return { field, op: "is not", value: null };
        }
        return { field, op: "is not", value: parseValueToken(expectValue()) };
      }
      if (matchKeyword("null")) {
        return { field, op: "is", value: null };
      }
      return { field, op: "is", value: parseValueToken(expectValue()) };
    }

    if (matchKeyword("between")) {
      const left = parseValueToken(expectValue());
      if (!matchKeyword("and")) {
        throw new Error("Invalid BETWEEN clause");
      }
      const right = parseValueToken(expectValue());
      return { field, op: "between", value: [left, right] };
    }

    if (matchKeyword("like")) {
      return { field, op: "like", value: parseValueToken(expectValue()) };
    }

    if (matchKeyword("in")) {
      expect("lparen");
      const values = [];
      if (peek() && peek().type !== "rparen") {
        values.push(parseValueToken(expectValue()));
        while (peek() && peek().type === "comma") {
          consume();
          values.push(parseValueToken(expectValue()));
        }
      }
      expect("rparen");
      return { field, op: "in", value: values };
    }

    const opToken = expect("op");
    return {
      field,
      op: opToken.value,
      value: parseValueToken(expectValue()),
    };
  }

  function expectValue() {
    const token = peek();
    if (!token) {
      throw new Error("Expected value in WHERE clause");
    }
    // Check if value is a function call
    if (
      token.type === "word" &&
      SQL_FUNC_NAMES.has(token.value.toLowerCase())
    ) {
      const funcResult = collectFuncExpression();
      return { type: "func", value: funcResult };
    }
    if (
      token.type === "word" ||
      token.type === "string" ||
      token.type === "number"
    ) {
      return consume();
    }
    throw new Error("Invalid value in WHERE clause: " + token.value);
  }

  function parseValueToken(token) {
    if (token.type === "func") return token.value;
    if (token.type === "string") return token.value;
    return parseValue(token.value);
  }

  // Collect tokens for a function call expression like UPPER(name) or CONCAT(a, ' ', b)
  function collectFuncExpression() {
    const nameToken = consume(); // function name
    const funcName = nameToken.value.toLowerCase();
    const mapping = SQL_FUNC_MAP[funcName];
    if (!mapping) {
      throw new Error("Unknown function: " + funcName);
    }
    expect("lparen");
    const args = [];
    if (peek() && peek().type !== "rparen") {
      args.push(parseFuncArg());
      while (peek() && peek().type === "comma") {
        consume(); // comma
        args.push(parseFuncArg());
      }
    }
    expect("rparen");
    return { __func: true, type: mapping.type, op: mapping.op, args };
  }

  function parseFuncArg() {
    const token = peek();
    if (!token) throw new Error("Expected function argument");
    // Nested function call
    if (
      token.type === "word" &&
      SQL_FUNC_NAMES.has(token.value.toLowerCase())
    ) {
      return collectFuncExpression();
    }
    // String literal
    if (token.type === "string") {
      return consume().value;
    }
    // Number literal
    if (token.type === "number") {
      return parseValue(consume().value);
    }
    // Field name
    if (token.type === "word") {
      return consume().value;
    }
    throw new Error("Invalid function argument: " + token.value);
  }

  const expr = parseExpression();
  if (index < tokens.length) {
    throw new Error("Invalid WHERE clause near: " + tokens[index].value);
  }
  return expr;
}

function tokenizeWhere(text) {
  const tokens = [];
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    if (ch === "(") {
      tokens.push({ type: "lparen", value: ch });
      i += 1;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "rparen", value: ch });
      i += 1;
      continue;
    }
    if (ch === ",") {
      tokens.push({ type: "comma", value: ch });
      i += 1;
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      let value = "";
      i += 1;
      while (i < text.length) {
        const curr = text[i];
        if (curr === "\\" && i + 1 < text.length) {
          value += text[i + 1];
          i += 2;
          continue;
        }
        if (curr === quote) {
          i += 1;
          break;
        }
        value += curr;
        i += 1;
      }
      tokens.push({ type: "string", value });
      continue;
    }

    // Handle PostgreSQL arrow operators: treat -> and ->> as part of field names
    if ((text[i] === "-" && text[i + 1] === ">") || text[i] === ".") {
      let value = "";
      while (i < text.length) {
        const curr = text[i];
        // Continue if part of arrow operator or dot notation or bracket notation
        if (curr === "-" && i + 1 < text.length && text[i + 1] === ">") {
          value += "->";
          i += 2;
          if (i < text.length && text[i] === ">") {
            value += ">";
            i++;
          }
          // Skip the quote if present
          if (i < text.length && (text[i] === "'" || text[i] === '"')) {
            const quote = text[i];
            i++;
            while (i < text.length && text[i] !== quote) {
              value += text[i];
              i++;
            }
            if (i < text.length) i++;
          }
        } else if (curr === "." || (curr === "[" && /\d/.test(text[i + 1]))) {
          value += curr;
          i++;
          if (curr === "[") {
            while (i < text.length && text[i] !== "]") {
              value += text[i];
              i++;
            }
            if (i < text.length) {
              value += text[i];
              i++;
            }
          }
        } else if (/\w/.test(curr)) {
          value += curr;
          i++;
        } else {
          break;
        }
      }
      if (value) {
        tokens.push({ type: "word", value });
      }
      continue;
    }

    const twoChar = text.slice(i, i + 2);
    if ([">=", "<=", "!="].includes(twoChar)) {
      tokens.push({ type: "op", value: twoChar });
      i += 2;
      continue;
    }
    if (["=", ">", "<", "+", "*", "/", "%"].includes(ch)) {
      tokens.push({ type: "op", value: ch });
      i += 1;
      continue;
    }
    // Handle minus: could be a negative number or a math operator
    if (ch === "-") {
      // If previous token is a word/number/rparen, it's a math operator
      const prevToken = tokens[tokens.length - 1];
      if (
        prevToken &&
        (prevToken.type === "word" ||
          prevToken.type === "number" ||
          prevToken.type === "rparen")
      ) {
        tokens.push({ type: "op", value: "-" });
        i += 1;
        continue;
      }
    }

    let value = "";
    while (i < text.length) {
      const curr = text[i];
      if (/\s|\(|\)|,/.test(curr)) break;
      value += curr;
      i += 1;
    }
    tokens.push({ type: "word", value });
  }

  return tokens;
}

function parseWherePart(part) {
  const isNotNullMatch = part.match(/^([^\s]+)\s+is\s+not\s+null$/i);
  if (isNotNullMatch) {
    return { field: isNotNullMatch[1].trim(), op: "is not", value: null };
  }

  const isNullMatch = part.match(/^([^\s]+)\s+is\s+null$/i);
  if (isNullMatch) {
    return { field: isNullMatch[1].trim(), op: "is", value: null };
  }

  const betweenMatch = part.match(/^([^\s]+)\s+between\s+(.+)\s+and\s+(.+)$/i);
  if (betweenMatch) {
    return {
      field: betweenMatch[1].trim(),
      op: "between",
      value: [
        parseValue(betweenMatch[2].trim()),
        parseValue(betweenMatch[3].trim()),
      ],
    };
  }

  const likeMatch = part.match(/^([^\s]+)\s+like\s+(.+)$/i);
  if (likeMatch) {
    return {
      field: likeMatch[1].trim(),
      op: "like",
      value: parseValue(likeMatch[2].trim()),
    };
  }

  const inMatch = part.match(/^([^\s]+)\s+in\s*\((.+)\)$/i);
  if (inMatch) {
    return {
      field: inMatch[1].trim(),
      op: "in",
      value: splitCsv(inMatch[2]).map(parseValue),
    };
  }

  const match = part.match(/^([^\s]+)\s*(=|!=|>=|<=|>|<)\s*(.+)$/);
  if (!match) {
    throw new Error("Invalid WHERE clause: " + part);
  }
  return {
    field: match[1].trim(),
    op: match[2],
    value: parseValue(match[3].trim()),
  };
}

function parseValue(value) {
  const quoted = value.match(/^['\"]([\s\S]*)['\"]$/);
  if (quoted) return quoted[1];
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (/^null$/i.test(value)) return null;
  const num = Number(value);
  if (!Number.isNaN(num)) return num;
  return value;
}

function splitCsv(text) {
  // Bracket-aware CSV split: respects commas inside (), {}, [], and strings
  const result = [];
  let depth = 0;
  let current = "";
  let inQuote = null;
  const OPENERS = { "(": 1, "{": 1, "[": 1 };
  const CLOSERS = { ")": 1, "}": 1, "]": 1 };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      current += ch;
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inQuote = ch;
      current += ch;
      continue;
    }
    if (OPENERS[ch]) {
      depth++;
      current += ch;
      continue;
    }
    if (CLOSERS[ch]) {
      depth--;
      current += ch;
      continue;
    }
    if (ch === "," && depth === 0) {
      result.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

const DUMMY_RESOURCES = Object.freeze({
  products: { path: "products", listKey: "products" },
  carts: { path: "carts", listKey: "carts" },
  users: { path: "users", listKey: "users" },
  posts: { path: "posts", listKey: "posts" },
  comments: { path: "comments", listKey: "comments" },
  quotes: { path: "quotes", listKey: "quotes" },
  todos: { path: "todos", listKey: "todos" },
});

function normalizeDummyOptions(options) {
  return {
    baseUrl: options.baseUrl || "https://dummyjson.com",
    resources: options.resources || null,
    skipMissing: !!options.skipMissing,
    fetch: options.fetch || null,
    ...options,
  };
}

function resolveFetch(fetchFn) {
  if (fetchFn) return fetchFn;
  if (typeof fetch !== "undefined") return fetch;
  throw new Error(
    "fetch is not available. Pass options.fetch in populateDummy().",
  );
}

function resolveDummyResources(options, schemaTables) {
  const resources = [];
  const names = options.resources || Object.keys(DUMMY_RESOURCES);

  for (const name of names) {
    const def = DUMMY_RESOURCES[name];
    if (!def) continue;
    const config = options[name];
    if (config === false) continue;
    const table =
      (config && config.table) ||
      (options.tableMap && options.tableMap[name]) ||
      name;
    const mode = (config && config.mode) || options.mode || "append";
    const limit = (config && config.limit) || options.limit || null;
    const skip = (config && config.skip) || options.skip || 0;
    const all = !!((config && config.all) || options.all);
    if (schemaTables && !schemaTables[table]) {
      if (options.skipMissing) {
        continue;
      }
      throw new Error("Missing table for dummy resource: " + table);
    }
    resources.push({ name, table, mode, limit, skip, all, def });
  }

  return resources;
}

async function fetchDummyResource(fetchFn, baseUrl, resource) {
  if (resource.all) {
    return fetchDummyAll(fetchFn, baseUrl, resource);
  }
  const payload = await fetchDummyPage(
    fetchFn,
    baseUrl,
    resource,
    resource.skip,
    resource.limit,
  );
  const list = payload[resource.def.listKey];
  return Array.isArray(list) ? list : [];
}

async function fetchDummyAll(fetchFn, baseUrl, resource) {
  const pageSize = resource.limit || 100;
  let skip = 0;
  let allRows = [];
  while (true) {
    const payload = await fetchDummyPage(
      fetchFn,
      baseUrl,
      resource,
      skip,
      pageSize,
    );
    const list = payload[resource.def.listKey];
    if (!Array.isArray(list) || list.length === 0) break;
    allRows = allRows.concat(list);
    skip += list.length;
    if (payload.total != null && skip >= payload.total) break;
  }
  return allRows;
}

async function fetchDummyPage(fetchFn, baseUrl, resource, skip, limit) {
  const url = buildDummyUrl(baseUrl, resource, skip, limit);
  const response = await fetchFn(url);
  if (!response.ok) {
    throw new Error("DummyJSON request failed: " + response.status);
  }
  return response.json();
}

function buildDummyUrl(baseUrl, resource, skip, limit) {
  const params = [];
  if (limit != null) params.push("limit=" + limit);
  if (skip) params.push("skip=" + skip);
  const query = params.length > 0 ? "?" + params.join("&") : "";
  return baseUrl.replace(/\/$/, "") + "/" + resource.def.path + query;
}

async function writeRows(store, rows) {
  let count = 0;
  for (const row of rows) {
    await promisifyRequest(store.put(row));
    count += 1;
  }
  return count;
}

if (typeof module !== "undefined") {
  module.exports = { IndexQL };
}
