import { XMLBuilder, XMLParser } from "fast-xml-parser";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import YAML from "yaml";

/**
 * Structured data formats that map cleanly onto one another.
 *
 * These conversions are mechanical and lossless in both directions for
 * anything that fits the target format's data model. Where a target genuinely
 * cannot represent the source (INI has no nested objects beyond one section
 * level; CSV has no nesting at all), the limitation is raised as an error
 * rather than papered over with a silently flattened file.
 */
export type DataFormat =
  | "json"
  | "yaml"
  | "toml"
  | "ini"
  | "xml"
  | "csv"
  | "tsv"
  | "dotenv";

export const DATA_FORMATS: readonly DataFormat[] = [
  "json",
  "yaml",
  "toml",
  "ini",
  "xml",
  "csv",
  "tsv",
  "dotenv",
];

export function isDataFormat(value: string): value is DataFormat {
  return (DATA_FORMATS as readonly string[]).includes(value);
}

export class ConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversionError";
  }
}

/* ------------------------------- parsing ------------------------------- */

export function parseData(text: string, format: DataFormat): unknown {
  switch (format) {
    case "json":
      return JSON.parse(text);
    case "yaml":
      return YAML.parse(text);
    case "toml":
      return parseToml(text);
    case "ini":
      return parseIni(text);
    case "dotenv":
      return parseDotenv(text);
    case "xml":
      return new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "@",
        parseTagValue: true,
      }).parse(text);
    case "csv":
      return parseDelimited(text, ",");
    case "tsv":
      return parseDelimited(text, "\t");
  }
}

export function serialiseData(value: unknown, format: DataFormat): string {
  switch (format) {
    case "json":
      return `${JSON.stringify(value, null, 2)}\n`;
    case "yaml":
      return YAML.stringify(value);
    case "toml":
      return stringifyToml(assertPlainObject(value, "TOML"));
    case "ini":
      return stringifyIni(assertPlainObject(value, "INI"));
    case "dotenv":
      return stringifyDotenv(assertPlainObject(value, "dotenv"));
    case "xml":
      return new XMLBuilder({
        ignoreAttributes: false,
        attributeNamePrefix: "@",
        format: true,
      }).build(wrapForXml(value));
    case "csv":
      return stringifyDelimited(value, ",");
    case "tsv":
      return stringifyDelimited(value, "\t");
  }
}

export function convertData(
  text: string,
  from: DataFormat,
  to: DataFormat,
): string {
  if (from === to) return text;
  let parsed: unknown;
  try {
    parsed = parseData(text, from);
  } catch (error) {
    throw new ConversionError(
      `Input is not valid ${from.toUpperCase()}: ${(error as Error).message}`,
    );
  }
  return serialiseData(parsed, to);
}

/* --------------------------------- INI --------------------------------- */

/**
 * INI parser covering the common dialect: `[section]` headers, `key = value`
 * pairs, `#` and `;` comments, and quoted values. Keys before any section land
 * at the top level.
 */
export function parseIni(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let section: Record<string, unknown> = result;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;

    const header = line.match(/^\[(.+?)\]$/);
    if (header?.[1] !== undefined) {
      const name = header[1].trim();
      const existing = result[name];
      if (existing && typeof existing === "object") {
        section = existing as Record<string, unknown>;
      } else {
        section = {};
        result[name] = section;
      }
      continue;
    }

    const eq = line.indexOf("=");
    if (eq === -1) {
      // A bare token is treated as a present-but-empty flag.
      section[line] = "";
      continue;
    }
    const key = line.slice(0, eq).trim();
    section[key] = coerceScalar(unquote(line.slice(eq + 1).trim()));
  }
  return result;
}

export function stringifyIni(value: Record<string, unknown>): string {
  const scalars: string[] = [];
  const sections: string[] = [];

  for (const [key, entry] of Object.entries(value)) {
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      const body = Object.entries(entry as Record<string, unknown>)
        .map(([k, v]) => {
          if (v !== null && typeof v === "object") {
            throw new ConversionError(
              `INI supports one level of sections; '${key}.${k}' is nested deeper. ` +
                `Convert to JSON, YAML or TOML instead.`,
            );
          }
          return `${k} = ${formatScalar(v)}`;
        })
        .join("\n");
      sections.push(`[${key}]\n${body}`);
    } else if (Array.isArray(entry)) {
      throw new ConversionError(
        `INI has no array syntax; key '${key}' is a list. Convert to JSON, YAML or TOML instead.`,
      );
    } else {
      scalars.push(`${key} = ${formatScalar(entry)}`);
    }
  }

  return [scalars.join("\n"), sections.join("\n\n")]
    .filter(Boolean)
    .join("\n\n")
    .concat("\n");
}

/* ------------------------------- dotenv -------------------------------- */

export function parseDotenv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    result[line.slice(0, eq).trim()] = unquote(line.slice(eq + 1).trim());
  }
  return result;
}

export function stringifyDotenv(value: Record<string, unknown>): string {
  return `${Object.entries(value)
    .map(([key, entry]) => {
      if (entry !== null && typeof entry === "object") {
        throw new ConversionError(
          `.env files hold flat key/value pairs; '${key}' is nested. Convert to JSON or YAML instead.`,
        );
      }
      const text = String(entry ?? "");
      const needsQuotes = /[\s#"'$]/.test(text);
      return `${key}=${needsQuotes ? JSON.stringify(text) : text}`;
    })
    .join("\n")}\n`;
}

/* ---------------------------- CSV and TSV ------------------------------ */

/** RFC 4180 style parser: quoted fields, doubled quotes, embedded newlines. */
export function parseDelimited(
  text: string,
  delimiter: string,
): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char ?? "";
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const header = rows.shift();
  if (!header) return [];
  return rows
    .filter((entry) => entry.some((cell) => cell !== ""))
    .map((entry) => {
      const record: Record<string, string> = {};
      header.forEach((name, index) => {
        record[name] = entry[index] ?? "";
      });
      return record;
    });
}

export function stringifyDelimited(value: unknown, delimiter: string): string {
  const rows = toRecordArray(value);
  if (rows.length === 0) return "";

  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key)) columns.push(key);
    }
  }

  const escape = (cell: unknown): string => {
    const text = cell === null || cell === undefined ? "" : String(cell);
    return new RegExp(`["${delimiter === "\t" ? "\\t" : delimiter}\\n]`).test(text)
      ? `"${text.replace(/"/g, '""')}"`
      : text;
  };

  const lines = [columns.join(delimiter)];
  for (const row of rows) {
    lines.push(columns.map((column) => escape(row[column])).join(delimiter));
  }
  return `${lines.join("\n")}\n`;
}

function toRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    if (value.every((entry) => entry !== null && typeof entry === "object")) {
      return value as Array<Record<string, unknown>>;
    }
    return value.map((entry) => ({ value: entry }));
  }
  if (value !== null && typeof value === "object") {
    // A single object becomes a one-row table; a map of arrays becomes rows.
    const entries = Object.entries(value as Record<string, unknown>);
    const arrayEntry = entries.find(([, v]) => Array.isArray(v));
    if (arrayEntry && entries.length === 1) {
      return toRecordArray(arrayEntry[1]);
    }
    return [value as Record<string, unknown>];
  }
  throw new ConversionError(
    "CSV needs a list of records (or an object containing one); this value is a bare scalar.",
  );
}

/* ------------------------------- helpers ------------------------------- */

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
    (value.startsWith("'") && value.endsWith("'") && value.length > 1)
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function coerceScalar(value: string): string | number | boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value !== "" && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /^\s|\s$|[#;]/.test(text) ? `"${text}"` : text;
}

function assertPlainObject(
  value: unknown,
  target: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConversionError(
      `${target} output needs a key/value mapping at the top level; got ${
        Array.isArray(value) ? "an array" : typeof value
      }.`,
    );
  }
  return value as Record<string, unknown>;
}

function wrapForXml(value: unknown): unknown {
  // XML needs exactly one root element.
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 1) return value;
  }
  return { root: value };
}
