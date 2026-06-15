import { logger } from '@/config/logger.js'
import { queryClient } from '@/db/client.js'
import * as businessService from '@/modules/business/business.service.js'

interface ParsedArgs {
  name?: string
  whatsapp?: string
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {}
  for (const arg of argv) {
    if (arg.startsWith('--name=')) {
      out.name = arg.slice('--name='.length)
    } else if (arg.startsWith('--whatsapp=')) {
      out.whatsapp = arg.slice('--whatsapp='.length)
    }
  }
  return out
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (!args.name || !args.whatsapp) {
    // biome-ignore lint/suspicious/noConsoleLog: CLI help text, not application log
    console.error('usage: npm run create:business -- --name="..." --whatsapp="+51XXXXXXXXX"')
    process.exit(2)
  }

  const result = await businessService.register({
    name: args.name,
    whatsappNumber: args.whatsapp,
  })

  if (!result.ok) {
    logger.error({ code: result.error.code, context: result.error.logContext }, result.error.message)
    process.exit(1)
  }

  logger.info(
    {
      id: result.data.id,
      name: result.data.name,
      whatsappNumber: result.data.whatsappNumber,
      timezone: result.data.timezone,
    },
    'business created — copy the id into .env as BUSINESS_ID',
  )

  // Also print the bare id to stdout so the user can pipe / copy it easily.
  // biome-ignore lint/suspicious/noConsoleLog: tooling output, not application log
  console.log(result.data.id)
}

main()
  .catch((err) => {
    logger.fatal({ err }, 'create:business failed')
    process.exit(1)
  })
  .finally(() => {
    queryClient.end().catch(() => undefined)
  })
