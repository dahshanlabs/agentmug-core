/**
 * Some provider dialects require an explicit `type` on every property schema,
 * even though standard JSON Schema permits type-less nodes such as
 * `{ enum: ["Text", "HTML"] }`. Return a deep clone with missing property
 * types inferred, leaving the shared registry definition untouched.
 */
export function normalizeExplicitToolPropertyTypes(
  inputSchema: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = cloneJsonSchemaValue(inputSchema) as Record<string, unknown>;
  normalizeSchemaContainer(normalized);
  return normalized;
}

function normalizeSchemaContainer(schema: Record<string, unknown>): void {
  const properties = schema.properties;
  if (isRecord(properties)) {
    for (const property of Object.values(properties)) {
      normalizeSchemaProperty(property);
    }
  }

  const items = schema.items;
  if (isRecord(items)) {
    normalizeSchemaProperty(items);
  } else if (Array.isArray(items)) {
    for (const item of items) normalizeSchemaProperty(item);
  }

  normalizeSchemaProperty(schema.additionalProperties);

  for (const listKey of ["anyOf", "oneOf", "allOf"]) {
    const children = schema[listKey];
    if (!Array.isArray(children)) continue;
    for (const child of children) normalizeSchemaProperty(child);
  }
}

function normalizeSchemaProperty(schema: unknown): void {
  if (!isRecord(schema)) return;
  if (!("type" in schema) && !SCHEMA_COMBINATORS.some((key) => key in schema)) {
    schema.type = inferSchemaType(schema);
  }
  normalizeSchemaContainer(schema);
}

function inferSchemaType(schema: Record<string, unknown>): string {
  const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined;
  if (enumValues && enumValues.length > 0) return inferTypeFromValues(enumValues);
  if ("const" in schema) return inferTypeFromValues([schema.const]);

  if (OBJECT_KEYWORDS.some((key) => key in schema)) return "object";
  if (ARRAY_KEYWORDS.some((key) => key in schema)) return "array";
  if (STRING_KEYWORDS.some((key) => key in schema)) return "string";
  if (NUMERIC_KEYWORDS.some((key) => key in schema)) return "number";
  return "string";
}

function inferTypeFromValues(values: unknown[]): string {
  const inferred = new Set<string>();
  for (const value of values) {
    if (typeof value === "boolean") inferred.add("boolean");
    else if (typeof value === "number") {
      inferred.add(Number.isInteger(value) ? "integer" : "number");
    } else if (typeof value === "string") inferred.add("string");
    else if (value === null) inferred.add("null");
    else if (Array.isArray(value)) inferred.add("array");
    else if (isRecord(value)) inferred.add("object");
    else return "string";
  }

  if (inferred.size === 1) return [...inferred][0]!;
  if (inferred.size === 2 && inferred.has("integer") && inferred.has("number")) {
    return "number";
  }
  return "string";
}

function cloneJsonSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJsonSchemaValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, cloneJsonSchemaValue(child)]),
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SCHEMA_COMBINATORS = [
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "$ref",
] as const;
const OBJECT_KEYWORDS = [
  "properties",
  "additionalProperties",
  "patternProperties",
  "propertyNames",
  "required",
  "minProperties",
  "maxProperties",
] as const;
const ARRAY_KEYWORDS = [
  "items",
  "prefixItems",
  "minItems",
  "maxItems",
  "uniqueItems",
  "contains",
] as const;
const STRING_KEYWORDS = ["minLength", "maxLength", "pattern", "format"] as const;
const NUMERIC_KEYWORDS = [
  "minimum",
  "maximum",
  "multipleOf",
  "exclusiveMinimum",
  "exclusiveMaximum",
] as const;
