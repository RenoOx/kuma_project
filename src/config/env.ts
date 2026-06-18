import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url("DATABASE_URL must be a valid URL"),
  TEST_DATABASE_URL: z.string().url("TEST_DATABASE_URL must be a valid URL"),
  REDIS_URL: z.string().url().optional(),
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
  PROD_DATABASE_URL: z.string().url().optional(),
  // Optional: when set, the dev server boots a Baileys client for this business.
  // Preprocess turns an empty .env value (`BUSINESS_ID=`) into undefined so
  // `.optional()` actually treats "unset" the same as "absent".
  BUSINESS_ID: z.preprocess(
    (v) => (typeof v === "string" && v.length === 0 ? undefined : v),
    z.string().min(1).optional(),
  ),
  // Google Calendar OAuth. Optional at boot — runtime checks in
  // google.client raise a clear error if a flow needs them and they're
  // missing. Lets the rest of the app run before Google is configured.
  GOOGLE_CLIENT_ID: z.preprocess(
    (v) => (typeof v === "string" && v.length === 0 ? undefined : v),
    z.string().min(1).optional(),
  ),
  GOOGLE_CLIENT_SECRET: z.preprocess(
    (v) => (typeof v === "string" && v.length === 0 ? undefined : v),
    z.string().min(1).optional(),
  ),
  GOOGLE_REDIRECT_URI: z
    .url()
    .default("http://localhost:3000/auth/google/callback"),
  SESSIONS_DIR: z.string().default("./sessions"),
});

export type Env = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  // biome-ignore lint/suspicious/noConsoleLog: bootstrap failure before logger is available
  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

export const env: Env = parsed.data;
