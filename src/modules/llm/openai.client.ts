import { env } from '@/config/env.js'
import OpenAI from 'openai'

export const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY })
