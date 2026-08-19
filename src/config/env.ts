import { config as loadDotenv } from 'dotenv'
import { z } from 'zod'

loadDotenv()

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid URL'),
  TEST_DATABASE_URL: z.string().url('TEST_DATABASE_URL must be a valid URL').optional(),
  REDIS_URL: z.string().url().optional(),
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),
  PROD_DATABASE_URL: z.string().url().optional(),
  // Google Calendar OAuth. Optional at boot — runtime checks in
  // google.client raise a clear error if a flow needs them and they're
  // missing. Lets the rest of the app run before Google is configured.
  GOOGLE_CLIENT_ID: z.preprocess(
    (v) => (typeof v === 'string' && v.length === 0 ? undefined : v),
    z.string().min(1).optional(),
  ),
  GOOGLE_CLIENT_SECRET: z.preprocess(
    (v) => (typeof v === 'string' && v.length === 0 ? undefined : v),
    z.string().min(1).optional(),
  ),
  GOOGLE_REDIRECT_URI: z.url().default('http://localhost:3000/auth/google/callback'),
  SESSIONS_DIR: z.string().default('./sessions'),
  // How long to wait for more messages from the same sender before treating the
  // burst as a single turn. WhatsApp users type in fragments ("te dije que
  // todavía" / "reagendala") and the right pause is a product call that needs
  // tuning against real conversations — hence an env var rather than a constant,
  // so it can be changed on the platform without a redeploy. 0 disables it.
  MESSAGE_DEBOUNCE_MS: z.coerce.number().int().min(0).max(30_000).default(4000),
  // Admin endpoints (QR page, etc.). If unset the endpoints return 501.
  ADMIN_SECRET: z.preprocess(
    (v) => (typeof v === 'string' && v.length === 0 ? undefined : v),
    z.string().min(8).optional(),
  ),
  // Knowledge base retrieval strategy. "category" is the keyword-routed lookup
  // in use today. "semantic" is reserved for the RAG migration and currently
  // falls back to "category" at runtime (see knowledgeBaseSearch.service).
  KB_SEARCH_MODE: z.enum(['category', 'semantic']).default('category'),
  // E.164 phone of the Vamvu Labs admin who can send #demo commands via WA.
  // If unset the demo feature is disabled. E.g. "+51999123456"
  DEMO_ADMIN_PHONE: z.preprocess(
    (v) => (typeof v === 'string' && v.length === 0 ? undefined : v),
    z.string().min(1).optional(),
  ),
})

export type Env = z.infer<typeof envSchema>

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
    .join('\n')
  // Bootstrap failure: the logger reads env, so it does not exist yet here.
  console.error(`Invalid environment configuration:\n${issues}`)
  process.exit(1)
}

export const env: Env = parsed.data
